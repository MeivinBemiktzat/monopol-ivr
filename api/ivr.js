// ============================================================================
// מונופול ישראל - Yemot Hamashiach IVR "type=api" module handler
// ----------------------------------------------------------------------------
// Single serverless endpoint that plays the entire game via Yemot's API module
// protocol. Yemot calls this URL (GET or POST) on every extension entry / user
// input, and expects a plain-text response describing what to do next
// (id_list_message / go_to_folder / read, etc — see Yemot docs).
//
// STATE: stored in Upstash Redis (env: UPSTASH_REDIS_REST_URL / _TOKEN).
// CUSTOM MESSAGES: for every message this system plays, it first checks
// (via id_list_message's native "s-" Speech type) whether a TTS file named
// like "s1010" exists in the Yemot extension. Yemot itself falls back to
// regular TTS text automatically if the file doesn't exist — so we just
// always emit BOTH: "s-<code>" (tries the uploaded file) is NOT combined
// automatically; instead we ask the caller's own Yemot extension to hold a
// per-message override file. Since Yemot has no server-side "does file X
// exist" check available to us over the API module (only via management
// API), we implement the requested behavior explicitly: we call the Yemot
// management API (GetTree) once per deploy-cache window to know which
// override files exist, and pick "s-<code>" (reads the uploaded TTS file)
// when present, otherwise "t-<hebrew text>" (regular Yemot TTS).
// ============================================================================

const board = require('./board.json');

// ---- Config from environment -----------------------------------------------
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const YEMOT_USERNAME = process.env.YEMOT_USERNAME || ''; // e.g. "0771234567" or "0771234567/0000"
const YEMOT_PASSWORD = process.env.YEMOT_PASSWORD || '';
const YEMOT_EXT_PATH = process.env.YEMOT_EXT_PATH || ''; // e.g. "ivr2:monopoly" the extension holding override files
const KEY_PREFIX = 'monopoly:'; // namespaced so this never collides with any other project's data in the same Redis

// ---- Small Redis (Upstash REST) helper -------------------------------------
async function redis(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const data = await res.json();
  return data.result;
}
const rGet = async (k) => redis(['GET', KEY_PREFIX + k]);
const rSet = async (k, v, ttlSeconds) =>
  ttlSeconds
    ? redis(['SET', KEY_PREFIX + k, v, 'EX', String(ttlSeconds)])
    : redis(['SET', KEY_PREFIX + k, v]);
const rDel = async (k) => redis(['DEL', KEY_PREFIX + k]);

const GAME_TTL = 60 * 60 * 12; // 12h idle expiry per game, so stale games don't pile up

async function loadGame(code) {
  const raw = await rGet(`game:${code}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveGame(code, game) {
  await rSet(`game:${code}`, JSON.stringify(game), GAME_TTL);
}

// ---- Custom-message-override cache (management API file listing) ----------
// Caches the extension's file list for a short time so we don't hammer the
// management API on every single message during a call.
let overrideCache = { list: null, at: 0 };
async function getOverrideFileSet() {
  if (!YEMOT_USERNAME || !YEMOT_PASSWORD || !YEMOT_EXT_PATH) return new Set();
  const now = Date.now();
  if (overrideCache.list && now - overrideCache.at < 30000) return overrideCache.list;
  try {
    const params = new URLSearchParams({
      token: `${YEMOT_USERNAME}:${YEMOT_PASSWORD}`,
      path: YEMOT_EXT_PATH,
    });
    const res = await fetch(`https://www.call2all.co.il/ym/api/GetTree?${params.toString()}`);
    const data = await res.json();
    const names = new Set();
    if (data && Array.isArray(data.tree)) {
      for (const item of data.tree) {
        // Strip extension (.tts/.wav) to compare against message codes like "s1010"
        const base = String(item.name || '').replace(/\.(tts|wav)$/i, '');
        names.add(base);
      }
    }
    overrideCache = { list: names, at: now };
    return names;
  } catch (e) {
    return overrideCache.list || new Set();
  }
}

// Builds an id_list_message-compatible segment for a message, given a unique
// message CODE (e.g. "s1010") and Hebrew fallback TEXT. If a file named like
// the code exists in the configured Yemot extension, we use Yemot's native
// Speech (s-) type to read that uploaded TTS file; otherwise we fall back to
// standard Yemot text-to-speech (t-) using the given text.
async function msg(code, text) {
  const overrides = await getOverrideFileSet();
  const clean = String(text).replace(/[.\-]/g, ' '); // id_list_message forbids "." and "-" inside t- text
  if (overrides.has(code)) {
    return `s-${code}`;
  }
  return `t-${clean}`;
}

// Joins multiple id_list_message segments with "."
function joinSegments(segments) {
  return segments.filter(Boolean).join('.');
}

// Convenience: build a full id_list_message response string, ending the call
// leg with either go_to_folder (repeat menu) or nothing (Yemot returns to
// previous step by default in api_end_goto, but we always explicitly loop
// back into this same extension to keep the game running).
function respond(segments, extra) {
  const body = `id_list_message=${joinSegments(segments)}`;
  return extra ? `${body}&${extra}` : body;
}

// ============================================================================
// GAME LOGIC HELPERS
// ============================================================================

function newGame(code) {
  return {
    code,
    createdAt: Date.now(),
    started: false,
    players: [], // {id, name, phone, money, pos, properties:[], inJail, jailTurns, doublesStreak, bankrupt}
    turn: 0,
    houses: {}, // squareIndex -> houseCount (0-4, 5=hotel)
    owners: {}, // squareIndex -> playerId
    mortgaged: {}, // squareIndex -> true
    pendingBuy: null, // squareIndex awaiting buy decision from current player
    log: [],
  };
}

function currentPlayer(game) {
  return game.players[game.turn % game.players.length];
}

function findPlayerByCallId(game, callId) {
  return game.players.find((p) => p.callId === callId);
}

function genGameCode() {
  return String(Math.floor(100 + Math.random() * 900)); // 100-999, 3 digits
}

function priceText(n) {
  return `${n} שקלים`;
}

function squareAt(i) {
  return board.squares[i % board.squares.length];
}

function rentFor(square, houses, ownerPropsInGroup) {
  if (square.type === 'railroad') {
    const idx = Math.min(houses, square.rent.length - 1);
    return square.rent[idx];
  }
  if (square.type === 'utility') {
    return null; // handled separately (needs dice roll context)
  }
  if (square.type === 'property') {
    const idx = Math.min(houses, square.rent.length - 1);
    let rent = square.rent[idx];
    // Monopoly (all same-color group owned, no houses yet) doubles base rent
    if (houses === 0 && ownerPropsInGroup) rent = rent * 2;
    return rent;
  }
  return 0;
}

function groupSquares(group) {
  return board.squares.filter((s) => s.type === 'property' && s.group === group);
}

function ownsFullGroup(game, playerId, group) {
  const squares = groupSquares(group);
  return squares.every((s) => game.owners[s.i] === playerId);
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  const params = { ...req.query, ...(req.body || {}) };
  const callId = params.ApiCallId || params.callId || 'unknown';
  const ext = params.ApiExtension || '';
  const hangup = params.hangup === 'yes';

  try {
    if (hangup) {
      // Player disconnected mid-game — leave state as-is so they can call back
      // and rejoin later via the game code; just acknowledge.
      res.status(200).send('ok');
      return;
    }

    // ---- Step routing based on a "step" query param we control -------------
    // Yemot always calls the same api_link. We track where the caller is in
    // our flow using the ApiExtension / a "step" param we send back to
    // ourselves as part of api_add_X constants isn't dynamic per-call, so
    // instead we keep a lightweight per-call flow pointer in Redis keyed by
    // callId. This lets us build a multi-screen menu with a single endpoint.

    const flowKey = `call:${callId}`;
    let flow = JSON.parse((await rGet(flowKey)) || '{}');

    // Entry point: caller just entered the extension (no prior step recorded)
    if (!flow.step) {
      flow = { step: 'main_menu' };
      await rSet(flowKey, JSON.stringify(flow), 3600);
      const welcome = await msg('s1000', 'ברוכים הבאים למונופול הטלפוני. להתחלת משחק חדש הקישו אחת. להצטרפות למשחק קיים הקישו שתיים');
      res.status(200).send(
        respond([welcome], `read=t-=CHOICE,,1,1,10,Number,yes,no,,,12`)
      );
      return;
    }

    // ---- MAIN MENU response -------------------------------------------------
    if (flow.step === 'main_menu') {
      const choice = params.CHOICE;
      if (choice === '1') {
        flow = { step: 'ask_player_count' };
        await rSet(flowKey, JSON.stringify(flow), 3600);
        const t = await msg('s1001', 'כמה שחקנים ישתתפו במשחק? הקישו מספר בין שתיים לשש');
        res.status(200).send(respond([t], `read=t-=PCOUNT,,1,1,10,Number,yes,no,,2.3.4.5.6`));
        return;
      }
      if (choice === '2') {
        flow = { step: 'ask_join_code' };
        await rSet(flowKey, JSON.stringify(flow), 3600);
        const t = await msg('s1002', 'הקישו את קוד המשחק בן שלוש הספרות');
        res.status(200).send(respond([t], `read=t-=JOINCODE,,3,3,10,Digits,yes,no`));
        return;
      }
      const err = await msg('s1003', 'בחירה לא חוקית');
      res.status(200).send(respond([err], `go_to_folder=/${ext}`));
      return;
    }

    // ---- CREATE GAME: ask player count -> create game -> ask name ----------
    if (flow.step === 'ask_player_count') {
      const n = parseInt(params.PCOUNT, 10);
      if (!n || n < 2 || n > 6) {
        const err = await msg('s1004', 'מספר לא תקין. נסו שוב');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }
      let code = genGameCode();
      let tries = 0;
      while ((await loadGame(code)) && tries < 20) {
        code = genGameCode();
        tries++;
      }
      const game = newGame(code);
      game.expectedPlayers = n;
      await saveGame(code, game);

      flow = { step: 'ask_name_new', code };
      await rSet(flowKey, JSON.stringify(flow), 3600);

      const t1 = await msg('s1005', `נוצר משחק חדש. קוד המשחק שלכם הוא`);
      const codeDigits = `d-${code}`;
      const t2 = await msg('s1006', 'שמרו את הקוד הזה ומסרו אותו לשאר השחקנים כדי שיוכלו להצטרף. כעת הקלידו את שמכם באמצעות המקלדת ולאחר מכן הקישו סולמית');
      res.status(200).send(
        respond([t1, codeDigits, t2], `read=t-=PNAME,,HebrewKeyboard,,,,,no`)
      );
      return;
    }

    // ---- JOIN GAME: ask code -> validate -> ask name ------------------------
    if (flow.step === 'ask_join_code') {
      const code = params.JOINCODE;
      const game = await loadGame(code);
      if (!game) {
        const err = await msg('s1007', 'קוד משחק לא נמצא');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }
      if (game.started) {
        const err = await msg('s1008', 'המשחק כבר התחיל ולא ניתן להצטרף אליו');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }
      if (game.players.length >= game.expectedPlayers) {
        const err = await msg('s1009', 'המשחק מלא');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }
      flow = { step: 'ask_name_join', code };
      await rSet(flowKey, JSON.stringify(flow), 3600);
      const t = await msg('s1010', 'הקלידו את שמכם באמצעות המקלדת ולאחר מכן הקישו סולמית');
      res.status(200).send(respond([t], `read=t-=PNAME,,HebrewKeyboard,,,,,no`));
      return;
    }

    // ---- Register player name (both new-game creator and joiners) ----------
    if (flow.step === 'ask_name_new' || flow.step === 'ask_name_join') {
      const code = flow.code;
      const game = await loadGame(code);
      if (!game) {
        const err = await msg('s1011', 'אירעה שגיאה, המשחק לא נמצא יותר');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }
      const name = (params.PNAME || 'שחקן').trim() || 'שחקן';
      const player = {
        id: `p${game.players.length + 1}`,
        callId,
        name,
        money: board.startMoney,
        pos: 0,
        properties: [],
        inJail: false,
        jailTurns: 0,
        doublesStreak: 0,
        bankrupt: false,
      };
      game.players.push(player);

      const readyToStart = game.players.length >= game.expectedPlayers;
      if (readyToStart) game.started = true;
      await saveGame(code, game);

      flow = { step: 'in_game', code, playerId: player.id };
      await rSet(flowKey, JSON.stringify(flow), 3600);

      const t1 = await msg('s1012', `נרשמת למשחק בהצלחה ${name}. יש לכם ${board.startMoney} שקלים`);
      if (!readyToStart) {
        const t2 = await msg('s1013', 'ממתינים לשאר השחקנים להצטרף. אנא המתינו על הקו');
        res.status(200).send(respond([t1, t2], `read=t-=WAITPOLL,,1,1,5,Number,yes,Ok`));
        return;
      }
      const t2 = await msg('s1014', 'כל השחקנים הצטרפו. המשחק מתחיל');
      res.status(200).send(respond([t1, t2], turnMenuAction(game, player.id)));
      return;
    }

    // ---- Waiting-room poll (joined but game not full yet) -------------------
    if (flow.step === 'in_game') {
      const code = flow.code;
      const game = await loadGame(code);
      if (!game) {
        const err = await msg('s1011', 'אירעה שגיאה, המשחק לא נמצא יותר');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }
      const player = game.players.find((p) => p.id === flow.playerId);
      if (!player) {
        const err = await msg('s1015', 'שחקן לא נמצא');
        res.status(200).send(respond([err], `go_to_folder=/${ext}`));
        return;
      }

      if (!game.started) {
        const t = await msg('s1013', 'ממתינים לשאר השחקנים להצטרף. אנא המתינו על הקו');
        res.status(200).send(respond([t], `read=t-=WAITPOLL,,1,1,5,Number,yes,Ok`));
        return;
      }

      // Game running: process this player's menu choice
      return handleInGameAction(req, res, game, player, params);
    }

    // Unknown step fallback
    await rDel(flowKey);
    const err = await msg('s1099', 'אירעה שגיאה לא צפויה, חוזרים לתפריט הראשי');
    res.status(200).send(respond([err], `go_to_folder=/${ext}`));
  } catch (e) {
    console.error(e);
    res.status(200).send('id_list_message=m-1607'); // "no response from API server" style fallback message
  }
};

// ============================================================================
// IN-GAME TURN HANDLING
// ============================================================================

// Builds the read= action for the acting player's turn menu, OR — if it's not
// their turn — a status/waiting loop for everyone else.
function turnMenuAction(game, listeningPlayerId) {
  const active = currentPlayer(game);
  if (active.id === listeningPlayerId) {
    return `read=t-=ACTION,,1,1,15,Number,yes,Ok`;
  }
  return `read=t-=ACTION,,1,1,15,Number,yes,Ok`;
}

async function handleInGameAction(req, res, game, player, params) {
  const active = currentPlayer(game);
  const isMyTurn = active.id === player.id && !active.bankrupt;

  if (!isMyTurn) {
    // Spectating players just hear the latest log line and re-poll
    const line = game.log.length ? game.log[game.log.length - 1] : '';
    const t = line
      ? await msg('sTURNLOG_' + game.log.length, line)
      : await msg('s1016', 'ממתינים לתור שלכם');
    res.status(200).send(respond([t], `read=t-=ACTION,,1,1,8,Number,yes,Ok`));
    return;
  }

  const action = params.ACTION;

  // No action yet this call — first arrival at the turn: announce status & options
  if (!action || action === '') {
    return sendTurnOptions(res, game, player, []);
  }

  // Pending buy decision takes priority
  if (game.pendingBuy !== null && game.pendingBuy !== undefined) {
    return handleBuyDecision(res, game, player, action);
  }

  if (action === '1') {
    return rollDiceAndMove(res, game, player);
  }
  if (action === '2') {
    return announcePersonalStatus(res, game, player);
  }
  if (action === '3') {
    return handleBuildHouses(res, game, player);
  }
  if (action === '4') {
    return endTurn(res, game, player);
  }

  return sendTurnOptions(res, game, player, [await msg('s1017', 'בחירה לא חוקית')]);
}

async function sendTurnOptions(res, game, player, prefixSegments) {
  const t1 = await msg('s1018', `זהו תורך ${player.name}. יש לכם ${player.money} שקלים`);
  const t2 = await msg('s1019', 'להטלת קוביות הקישו אחת. לשמיעת מצב אישי הקישו שתיים. לבניית בתים הקישו שלוש. לסיום התור הקישו ארבע');
  await saveGame(game.code, game);
  res.status(200).send(respond([...prefixSegments, t1, t2], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
}

async function broadcastLog(game, text) {
  game.log.push(text);
  if (game.log.length > 50) game.log.shift();
}

async function rollDiceAndMove(res, game, player) {
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  const isDouble = d1 === d2;

  if (player.inJail) {
    if (isDouble) {
      player.inJail = false;
      player.jailTurns = 0;
      await broadcastLog(game, `${player.name} הטיל דאבל ויצא מהכלא`);
    } else {
      player.jailTurns += 1;
      if (player.jailTurns >= 3) {
        player.inJail = false;
        player.jailTurns = 0;
        player.money -= board.jailFine;
        await broadcastLog(game, `${player.name} שילם קנס ${board.jailFine} שקלים ויצא מהכלא`);
      } else {
        await broadcastLog(game, `${player.name} נשאר בכלא (לא יצא דאבל)`);
        await saveGame(game.code, game);
        const t = await msg('s1020', `הטלתם ${d1} ו${d2}. נשארתם בכלא`);
        res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
        return;
      }
    }
  }

  if (isDouble) {
    player.doublesStreak = (player.doublesStreak || 0) + 1;
    if (player.doublesStreak >= 3) {
      player.doublesStreak = 0;
      sendToJail(player);
      await broadcastLog(game, `${player.name} הטיל דאבל שלוש פעמים ברציפות ונשלח לכלא`);
      await saveGame(game.code, game);
      const t = await msg('s1021', 'שלוש פעמים דאבל ברציפות. אתם נשלחים לכלא');
      res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
      return;
    }
  } else {
    player.doublesStreak = 0;
  }

  const steps = d1 + d2;
  const oldPos = player.pos;
  player.pos = (player.pos + steps) % board.squares.length;
  const passedGo = player.pos <= oldPos && !player.inJail;
  if (passedGo) {
    player.money += board.goMoney;
  }

  const square = squareAt(player.pos);
  await broadcastLog(game, `${player.name} הטיל ${d1} ו${d2} ונחת על ${square.name}`);

  const diceMsg = await msg('sDICE', `הטלתם ${d1} ו${d2}. נחתתם על ${square.name}`);
  const segments = [diceMsg];
  if (passedGo) {
    segments.push(await msg('s1022', `עברתם בהתחלה וקיבלתם ${board.goMoney} שקלים`));
  }

  return resolveSquare(res, game, player, square, segments);
}

function sendToJail(player) {
  const jailIndex = board.squares.find((s) => s.type === 'jail' || s.type === 'gotojail')?.i ?? 10;
  player.pos = 10; // classic jail square index
  player.inJail = true;
  player.jailTurns = 0;
}

async function resolveSquare(res, game, player, square, segments) {
  if (square.type === 'gotojail') {
    sendToJail(player);
    segments.push(await msg('s1023', 'נחתתם על לך לכלא. אתם נשלחים לכלא'));
    await saveGame(game.code, game);
    res.status(200).send(respond(segments, `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  if (square.type === 'tax') {
    player.money -= square.amount;
    await broadcastLog(game, `${player.name} שילם מס בסך ${square.amount} שקלים`);
    segments.push(await msg('sTAX', `שילמתם מס בסך ${priceText(square.amount)}`));
    return checkBankruptcyThenContinue(res, game, player, segments);
  }

  if (square.type === 'go' || square.type === 'jail' || square.type === 'parking' || square.type === 'chest' || square.type === 'chance') {
    segments.push(await msg('sFREE', 'משבצת זו אינה דורשת פעולה'));
    await saveGame(game.code, game);
    res.status(200).send(respond(segments, `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  // property / railroad / utility
  const owner = game.owners[square.i];
  if (!owner) {
    // Offer to buy
    game.pendingBuy = square.i;
    await saveGame(game.code, game);
    const t = await msg('sBUY', `הנכס ${square.name} פנוי לקנייה במחיר ${priceText(square.price)}. לקנייה הקישו אחת. לוותר הקישו שתיים`);
    res.status(200).send(respond([...segments, t], `read=t-=BUYCHOICE,,1,1,15,Number,yes,Ok`));
    return;
  }

  if (owner === player.id) {
    segments.push(await msg('sOWN', 'זהו נכס שלכם'));
    await saveGame(game.code, game);
    res.status(200).send(respond(segments, `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  if (game.mortgaged[square.i]) {
    segments.push(await msg('sMORTG', 'הנכס ממושכן ולא נגבית עליו שכירות'));
    await saveGame(game.code, game);
    res.status(200).send(respond(segments, `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  // Pay rent
  const houses = game.houses[square.i] || 0;
  let rent;
  if (square.type === 'railroad') {
    const ownedRailroads = board.squares.filter((s) => s.type === 'railroad' && game.owners[s.i] === owner).length;
    rent = square.rent[Math.min(ownedRailroads - 1, square.rent.length - 1)];
  } else if (square.type === 'utility') {
    const ownedUtilities = board.squares.filter((s) => s.type === 'utility' && game.owners[s.i] === owner).length;
    const multiplier = ownedUtilities >= 2 ? 10 : 4;
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    rent = (d1 + d2) * multiplier;
  } else {
    const hasFullGroup = ownsFullGroup(game, owner, square.group);
    rent = rentFor(square, houses, hasFullGroup);
  }

  player.money -= rent;
  const ownerPlayer = game.players.find((p) => p.id === owner);
  if (ownerPlayer) ownerPlayer.money += rent;

  await broadcastLog(game, `${player.name} שילם שכירות ${rent} שקלים ל${ownerPlayer ? ownerPlayer.name : 'שחקן'} עבור ${square.name}`);
  segments.push(await msg('sRENT', `שילמתם שכירות בסך ${priceText(rent)} לבעל הנכס`));

  return checkBankruptcyThenContinue(res, game, player, segments);
}

async function checkBankruptcyThenContinue(res, game, player, segments) {
  if (player.money < 0) {
    // Try to auto-sell/mortgage properties before declaring bankruptcy
    liquidateIfNeeded(game, player);
  }
  if (player.money < 0) {
    player.bankrupt = true;
    // Release owned properties back to the bank
    for (const sqIndex of Object.keys(game.owners)) {
      if (game.owners[sqIndex] === player.id) {
        delete game.owners[sqIndex];
        delete game.houses[sqIndex];
        delete game.mortgaged[sqIndex];
      }
    }
    await broadcastLog(game, `${player.name} פשט את הרגל ויצא מהמשחק`);
    segments.push(await msg('sBANKRUPT', 'לא נותר לכם מספיק כסף. פשטתם את הרגל ואתם יוצאים מהמשחק'));

    const remaining = game.players.filter((p) => !p.bankrupt);
    await saveGame(game.code, game);
    if (remaining.length === 1) {
      segments.push(await msg('sWIN', `${remaining[0].name} הוא המנצח במשחק! ברכותינו`));
      res.status(200).send(respond(segments, `go_to_folder=/`));
      return;
    }
    res.status(200).send(respond(segments, `go_to_folder=/`));
    return;
  }

  await saveGame(game.code, game);
  res.status(200).send(respond(segments, `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
}

function liquidateIfNeeded(game, player) {
  const owned = Object.keys(game.owners).filter((k) => game.owners[k] === player.id);
  for (const sqIndexStr of owned) {
    if (player.money >= 0) break;
    const sqIndex = Number(sqIndexStr);
    if (!game.mortgaged[sqIndex]) {
      const square = squareAt(sqIndex);
      const mortgageValue = Math.floor((square.price || 100) / 2);
      game.mortgaged[sqIndex] = true;
      player.money += mortgageValue;
    }
  }
}

async function handleBuyDecision(res, game, player, action) {
  const sqIndex = game.pendingBuy;
  const square = squareAt(sqIndex);
  game.pendingBuy = null;

  if (action === '1') {
    if (player.money < square.price) {
      const t = await msg('sNOMONEY', 'אין לכם מספיק כסף לקנות נכס זה');
      await saveGame(game.code, game);
      res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
      return;
    }
    player.money -= square.price;
    game.owners[sqIndex] = player.id;
    await broadcastLog(game, `${player.name} קנה את ${square.name}. עלות ${square.price} שקלים`);
    const t = await msg('sBOUGHT', `קניתם את ${square.name} תמורת ${priceText(square.price)}`);
    await saveGame(game.code, game);
    res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  await broadcastLog(game, `${player.name} ויתר על קניית ${square.name}`);
  const t = await msg('sSKIP', 'ויתרתם על קניית הנכס');
  await saveGame(game.code, game);
  res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
}

async function announcePersonalStatus(res, game, player) {
  const owned = Object.keys(game.owners)
    .filter((k) => game.owners[k] === player.id)
    .map((k) => squareAt(Number(k)).name);
  const propsText = owned.length ? owned.join(', ') : 'אין נכסים';
  const t1 = await msg('sSTATUS1', `יש לכם ${player.money} שקלים`);
  const t2 = await msg('sSTATUS2', `הנכסים שלכם הם: ${propsText}`);
  res.status(200).send(respond([t1, t2], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
}

async function handleBuildHouses(res, game, player) {
  const owned = Object.keys(game.owners).filter((k) => game.owners[k] === player.id);
  const buildable = owned
    .map((k) => Number(k))
    .filter((i) => {
      const sq = squareAt(i);
      return sq.type === 'property' && ownsFullGroup(game, player.id, sq.group) && (game.houses[i] || 0) < 5;
    });

  if (buildable.length === 0) {
    const t = await msg('sNOBUILD', 'אין לכם כרגע נכסים זמינים לבנייה. יש צורך במונופול על קבוצת צבע שלמה');
    res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  // Build on the first eligible property automatically (kept simple for IVR flow)
  const sqIndex = buildable[0];
  const square = squareAt(sqIndex);
  const cost = square.houseCost || board.houseCostByGroup[square.group] || 50;
  if (player.money < cost) {
    const t = await msg('sNOMONEYBUILD', 'אין לכם מספיק כסף לבנייה');
    res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }
  player.money -= cost;
  game.houses[sqIndex] = (game.houses[sqIndex] || 0) + 1;
  const level = game.houses[sqIndex];
  const levelText = level >= 5 ? 'מלון' : `${level} בתים`;
  await broadcastLog(game, `${player.name} בנה על ${square.name}, כעת יש ${levelText}`);
  const t = await msg('sBUILT', `בניתם על ${square.name}. עלות ${priceText(cost)}. כעת יש שם ${levelText}`);
  await saveGame(game.code, game);
  res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
}

async function endTurn(res, game, player) {
  if (player.doublesStreak > 0 && !player.inJail) {
    // Rolled a double this turn (and not sent to jail) — plays again per official rules
    player.doublesStreak = 0; // reset streak marker for the extra turn bookkeeping
    await saveGame(game.code, game);
    const t = await msg('sAGAIN', 'הטלתם דאבל, אתם משחקים שוב');
    res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
    return;
  }

  let next = (game.turn + 1) % game.players.length;
  while (game.players[next].bankrupt) {
    next = (next + 1) % game.players.length;
  }
  game.turn = next;
  const nextPlayer = game.players[next];
  await broadcastLog(game, `עובר תור ל${nextPlayer.name}`);
  await saveGame(game.code, game);

  const t = await msg('sENDTURN', `סיימתם את תורכם. התור עובר ל${nextPlayer.name}`);
  res.status(200).send(respond([t], `read=t-=ACTION,,1,1,15,Number,yes,Ok`));
}
