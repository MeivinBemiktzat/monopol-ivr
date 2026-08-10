// ============================================================================
// מונופול ישראל - Yemot Hamashiach IVR "type=api" module handler
// ----------------------------------------------------------------------------
// Single serverless endpoint that plays the entire game via Yemot's API module
// protocol. Yemot calls this URL (GET or POST) on every extension entry / user
// input, and expects a plain-text response describing what to do next.
//
// STATE: stored in Upstash Redis (env: UPSTASH_REDIS_REST_URL / _TOKEN).
//
// CUSTOM MESSAGE OVERRIDES: every spoken message has a unique code (e.g.
// "s1010"). If a TTS file with that name exists in the configured Yemot
// extension (YEMOT_EXT_PATH), we use Yemot's native Speech type ("s-") to
// read it; otherwise we fall back to plain Yemot TTS ("t-") with default
// Hebrew text. Existence is checked via the Yemot management API (GetTree),
// cached briefly so we don't hammer it on every message.
//
// WAITING / BROADCAST DESIGN (rewritten):
// `read=` is for collecting a keypress/voice/typed answer — its built-in
// "no answer" handling always wants to either re-prompt with an error
// (M1002 "לא הוקשה בחירה") or need an explicit `Ok` (proceed silently) flag
// on field 12. Neither of those is a good fit for "sit and wait, quietly,
// while other players act" — there's nothing to answer yet. So idle waiting
// (waiting for other players to join, waiting for your turn) instead uses
// `music_on_hold=<name>,<seconds>` which plays hold music for N seconds and
// then automatically calls us back — no confirm prompts, no "invalid
// choice" errors, no dead air. On every such callback we check whether
// anything changed (game started / new turn / new game-log entries this
// player hasn't heard yet) and, if so, announce it before resuming.
// ============================================================================

const board = require('./board.json');

// ---- Config from environment -----------------------------------------------
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const YEMOT_USERNAME = process.env.YEMOT_USERNAME || '';
const YEMOT_PASSWORD = process.env.YEMOT_PASSWORD || '';
const YEMOT_EXT_PATH = process.env.YEMOT_EXT_PATH || '';
const HOLD_MUSIC_NAME = process.env.YEMOT_HOLD_MUSIC || ''; // empty = system default hold music
const HOLD_SECONDS = 4; // short poll interval while waiting, so updates feel near-live
const KEY_PREFIX = 'monopoly:';

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

const GAME_TTL = 60 * 60 * 12; // 12h idle expiry per game

async function loadGame(code) {
  const raw = await rGet(`game:${code}`);
  return raw ? JSON.parse(raw) : null;
}
async function saveGame(code, game) {
  await rSet(`game:${code}`, JSON.stringify(game), GAME_TTL);
}

// ---- Custom-message-override cache (management API file listing) ----------
let overrideCache = { list: null, at: 0 };
async function getOverrideFileSet() {
  if (!YEMOT_USERNAME || !YEMOT_PASSWORD || !YEMOT_EXT_PATH) return new Set();
  const now = Date.now();
  if (overrideCache.list && now - overrideCache.at < 30000) return overrideCache.list;
  try {
    const qs = new URLSearchParams({
      token: `${YEMOT_USERNAME}:${YEMOT_PASSWORD}`,
      path: YEMOT_EXT_PATH,
    });
    const res = await fetch(`https://www.call2all.co.il/ym/api/GetTree?${qs.toString()}`);
    const data = await res.json();
    const names = new Set();
    if (data && Array.isArray(data.tree)) {
      for (const item of data.tree) {
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

// Builds an id_list_message-compatible segment for message CODE + fallback
// Hebrew TEXT — "s-<code>" if an override file exists, else "t-<text>".
async function msg(code, text) {
  const overrides = await getOverrideFileSet();
  const clean = String(text).replace(/[.\-]/g, ' '); // "." and "-" are segment delimiters, must not appear inside t- text
  if (overrides.has(code)) return `s-${code}`;
  return `t-${clean}`;
}

function joinSegments(segments) {
  return segments.filter(Boolean).join('.');
}

// ---- read= builder -----------------------------------------------------
// Correct Yemot field order for a keypress-type read (fields 1-15):
//  1 paramName          2 useExisting        3 maxDigits
//  4 minDigits           5 timeoutSeconds     6 playbackStyle (Number/Digits/NO)
//  7 blockStar (yes/no)  8 blockZero (yes/no) 9 keyReplace
// 10 allowedKeys        11 retryCount        12 onEmpty ("Ok"=proceed silently)
// 13 valueWhenEmpty     14 keyboardLangLock  15 askConfirm ("no"=disabled)
//
// We ALWAYS pass "no" for field 15 so Yemot never plays the "לאישור הקישו
// אחת" confirmation prompt after every keypress.
function menuReadParams({
  name,
  max = 1,
  min = 1,
  timeout = 15,
  playback = 'Number',
  allowed = '', // e.g. "1234" to restrict which digits are valid; '' = any
  onEmptyOk = true,
  retries = 1,
}) {
  const onEmpty = onEmptyOk ? 'Ok' : ''; // field 12
  return [
    name, // 1
    '', // 2 useExisting
    max, // 3
    min, // 4
    timeout, // 5
    playback, // 6
    'no', // 7 blockStar
    'no', // 8 blockZero
    '', // 9 keyReplace
    allowed, // 10 allowedKeys
    retries, // 11
    onEmpty, // 12
    '', // 13 valueWhenEmpty
    '', // 14
    'no', // 15 askConfirm -> DISABLED EVERYWHERE
  ].join(',');
}

// Typed free-text name entry via the physical/Hebrew keypad-letters mode.
// Per Yemot docs the dataType value itself is "HebrewKeyboard"; fields after
// it are the same generic slots (timeout, allowed keys, etc.) — we only need
// to set the essentials and MUST still disable the confirm prompt (field 15
// counted from the dataType slot for keypress-family types).
function keyboardReadParams({ name, timeout = 25 }) {
  return [
    name, // 1
    '', // 2 useExisting
    'HebrewKeyboard', // 3 dataType
    '', // 4 (unused for keyboard)
    timeout, // 5 timeout seconds
    '', // 6
    'no', // 7
    'no', // 8
    '', // 9
    '', // 10
    '', // 11
    'Ok', // 12 onEmpty -> proceed rather than error if somehow empty
    '', // 13
    '', // 14 InsertLettersTypeChangeNo left default (allow language switch)
    'no', // 15 askConfirm -> disabled
  ].join(',');
}

// Builds the final response string.
// - If `readParams` given: "read=<spoken prompt>=<readParams>"
// - Else if `hold` given: "id_list_message=<prompt>&music_on_hold=<hold>" —
//   used for idle waiting; Yemot plays hold music and calls us back after
//   the given seconds, no confirm/Error prompts involved at all.
// - Else: "id_list_message=<prompt>" optionally chained with `extra`
//   (e.g. go_to_folder=...).
function respond(segments, { readParams, hold, extra } = {}) {
  const prompt = joinSegments(segments);
  if (readParams) {
    const body = `read=${prompt}=${readParams}`;
    return extra ? `${body}&${extra}` : body;
  }
  if (hold) {
    const holdAction = `music_on_hold=${hold}`;
    return prompt ? `id_list_message=${prompt}&${holdAction}` : holdAction;
  }
  const body = `id_list_message=${prompt}`;
  return extra ? `${body}&${extra}` : body;
}

// Standard "wait quietly, then call us back" action string for polling.
function waitAction() {
  return `${HOLD_MUSIC_NAME},${HOLD_SECONDS}`;
}

// ============================================================================
// GAME LOGIC HELPERS
// ============================================================================

function newGame(code) {
  return {
    code,
    createdAt: Date.now(),
    started: false,
    players: [],
    turn: 0,
    houses: {},
    owners: {},
    mortgaged: {},
    pendingBuy: null,
    log: [], // { seq, text }
    logSeq: 0,
  };
}

function currentPlayer(game) {
  return game.players[game.turn % game.players.length];
}

function genGameCode() {
  return String(Math.floor(100 + Math.random() * 900));
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
  if (square.type === 'utility') return null;
  if (square.type === 'property') {
    const idx = Math.min(houses, square.rent.length - 1);
    let rent = square.rent[idx];
    if (houses === 0 && ownerPropsInGroup) rent = rent * 2;
    return rent;
  }
  return 0;
}

function groupSquares(group) {
  return board.squares.filter((s) => s.type === 'property' && s.group === group);
}

function ownsFullGroup(game, playerId, group) {
  return groupSquares(group).every((s) => game.owners[s.i] === playerId);
}

async function broadcastLog(game, text) {
  game.logSeq += 1;
  game.log.push({ seq: game.logSeq, text });
  if (game.log.length > 100) game.log.shift();
}

// Returns unseen log entries for a given player (by their lastSeenSeq) and
// the seq to remember as "seen" going forward.
function unseenLogFor(game, lastSeenSeq) {
  const unseen = game.log.filter((e) => e.seq > (lastSeenSeq || 0));
  return unseen;
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
      res.status(200).send('ok');
      return;
    }

    const flowKey = `call:${callId}`;
    let flow = JSON.parse((await rGet(flowKey)) || '{}');

    // ---- Entry point ---------------------------------------------------
    if (!flow.step) {
      flow = { step: 'main_menu' };
      await rSet(flowKey, JSON.stringify(flow), 3600);
      const welcome = await msg('s1000', 'ברוכים הבאים למונופול הטלפוני. להתחלת משחק חדש הקישו אחת. להצטרפות למשחק קיים הקישו שתיים');
      res.status(200).send(
        respond([welcome], {
          readParams: menuReadParams({ name: 'CHOICE', allowed: '12' }),
        })
      );
      return;
    }

    // ---- MAIN MENU -------------------------------------------------------
    if (flow.step === 'main_menu') {
      const choice = params.CHOICE;
      if (choice === '1') {
        flow = { step: 'ask_player_count' };
        await rSet(flowKey, JSON.stringify(flow), 3600);
        const t = await msg('s1001', 'כמה שחקנים ישתתפו במשחק? הקישו מספר בין שתיים לשש');
        res.status(200).send(
          respond([t], { readParams: menuReadParams({ name: 'PCOUNT', allowed: '23456' }) })
        );
        return;
      }
      if (choice === '2') {
        flow = { step: 'ask_join_code' };
        await rSet(flowKey, JSON.stringify(flow), 3600);
        const t = await msg('s1002', 'הקישו את קוד המשחק בן שלוש הספרות');
        res.status(200).send(
          respond([t], {
            readParams: menuReadParams({ name: 'JOINCODE', max: 3, min: 3, playback: 'Digits' }),
          })
        );
        return;
      }
      const err = await msg('s1003', 'בחירה לא חוקית');
      res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
      return;
    }

    // ---- CREATE GAME: ask player count -> create -> ask name -------------
    if (flow.step === 'ask_player_count') {
      const n = parseInt(params.PCOUNT, 10);
      if (!n || n < 2 || n > 6) {
        const err = await msg('s1004', 'מספר לא תקין. נסו שוב');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
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

      const t1 = await msg('s1005', 'נוצר משחק חדש. קוד המשחק שלכם הוא');
      const codeDigits = `d-${code}`;
      const t2 = await msg('s1006', 'שמרו את הקוד ומסרו אותו לשאר השחקנים. כעת הקלידו את שמכם באמצעות המקלדת ולאחר מכן הקישו סולמית');
      res.status(200).send(
        respond([t1, codeDigits, t2], {
          readParams: keyboardReadParams({ name: 'PNAME' }),
        })
      );
      return;
    }

    // ---- JOIN GAME: ask code -> validate -> ask name ----------------------
    if (flow.step === 'ask_join_code') {
      const code = params.JOINCODE;
      const game = await loadGame(code);
      if (!game) {
        const err = await msg('s1007', 'קוד משחק לא נמצא');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
        return;
      }
      if (game.started) {
        const err = await msg('s1008', 'המשחק כבר התחיל ולא ניתן להצטרף אליו');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
        return;
      }
      if (game.players.length >= game.expectedPlayers) {
        const err = await msg('s1009', 'המשחק מלא');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
        return;
      }
      flow = { step: 'ask_name_join', code };
      await rSet(flowKey, JSON.stringify(flow), 3600);
      const t = await msg('s1010', 'הקלידו את שמכם באמצעות המקלדת ולאחר מכן הקישו סולמית');
      res.status(200).send(
        respond([t], { readParams: keyboardReadParams({ name: 'PNAME' }) })
      );
      return;
    }

    // ---- Register player name (creator + joiners) -------------------------
    if (flow.step === 'ask_name_new' || flow.step === 'ask_name_join') {
      const code = flow.code;
      const game = await loadGame(code);
      if (!game) {
        const err = await msg('s1011', 'אירעה שגיאה, המשחק לא נמצא יותר');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
        return;
      }
      const name = (params.PNAME || 'שחקן').toString().trim() || 'שחקן';
      const player = {
        id: `p${game.players.length + 1}`,
        callId,
        name,
        money: board.startMoney,
        pos: 0,
        inJail: false,
        jailTurns: 0,
        doublesStreak: 0,
        bankrupt: false,
        lastSeenSeq: 0,
      };
      game.players.push(player);

      const readyToStart = game.players.length >= game.expectedPlayers;
      if (readyToStart) {
        game.started = true;
        await broadcastLog(game, 'כל השחקנים הצטרפו. המשחק מתחיל');
      }
      await saveGame(code, game);

      flow = { step: 'in_game', code, playerId: player.id };
      await rSet(flowKey, JSON.stringify(flow), 3600);

      const t1 = await msg('s1012', `נרשמת למשחק בהצלחה ${name}. יש לכם ${board.startMoney} שקלים`);

      if (!readyToStart) {
        const t2 = await msg('s1013', 'ממתינים לשאר השחקנים להצטרף');
        res.status(200).send(respond([t1, t2], { hold: waitAction() }));
        return;
      }

      // Game just became full — this player (and everyone else, on their
      // own next poll) will now see started=true and move into turn flow.
      player.lastSeenSeq = game.logSeq; // they already heard "game starting" live
      await saveGame(code, game);
      return sendGameState(res, game, player, [t1]);
    }

    // ---- In-game: everything else routes through here ----------------------
    if (flow.step === 'in_game') {
      const code = flow.code;
      const game = await loadGame(code);
      if (!game) {
        const err = await msg('s1011', 'אירעה שגיאה, המשחק לא נמצא יותר');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
        return;
      }
      const player = game.players.find((p) => p.id === flow.playerId);
      if (!player) {
        const err = await msg('s1015', 'שחקן לא נמצא');
        res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
        return;
      }

      if (!game.started) {
        // Still waiting room — poll via hold music, check if it started meanwhile
        const t = await msg('s1013', 'ממתינים לשאר השחקנים להצטרף');
        res.status(200).send(respond([t], { hold: waitAction() }));
        return;
      }

      return handleInGameAction(req, res, game, player, params);
    }

    // Unknown step fallback
    await rDel(flowKey);
    const err = await msg('s1099', 'אירעה שגיאה לא צפויה, חוזרים לתפריט הראשי');
    res.status(200).send(respond([err], { extra: `go_to_folder=/${ext}` }));
  } catch (e) {
    console.error(e);
    res.status(200).send('id_list_message=m-1607');
  }
};

// ============================================================================
// IN-GAME FLOW
// ============================================================================

// Central dispatcher called whenever we need to decide what THIS player
// should hear right now: is it their turn (show action menu), or should
// they hear pending log updates and keep waiting (hold music loop)?
async function sendGameState(res, game, player, prefixSegments = []) {
  const active = currentPlayer(game);
  const unseen = unseenLogFor(game, player.lastSeenSeq);
  const announceSegments = [];
  for (const entry of unseen) {
    announceSegments.push(await msg('sLOG_' + entry.seq, entry.text));
  }
  player.lastSeenSeq = game.logSeq;
  await saveGame(game.code, game);

  if (active.id === player.id && !active.bankrupt) {
    const t1 = await msg('s1018', `זהו תורך ${player.name}. יש לכם ${player.money} שקלים`);
    const t2 = await msg('s1019', 'להטלת קוביות הקישו אחת. לשמיעת מצב אישי הקישו שתיים. לבניית בתים הקישו שלוש. לסיום התור הקישו ארבע');
    res.status(200).send(
      respond([...prefixSegments, ...announceSegments, t1, t2], {
        readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }),
      })
    );
    return;
  }

  // Not my turn: play any announcements, then quietly hold and re-poll
  res.status(200).send(respond([...prefixSegments, ...announceSegments], { hold: waitAction() }));
}

async function handleInGameAction(req, res, game, player, params) {
  const action = params.ACTION;
  const buyChoice = params.BUYCHOICE;

  // Coming back from a hold-music wait (no ACTION param at all) — just
  // re-evaluate state: announce anything new, resume waiting or show menu.
  if (action === undefined && buyChoice === undefined) {
    return sendGameState(res, game, player, []);
  }

  const active = currentPlayer(game);
  const isMyTurn = active.id === player.id && !active.bankrupt;

  if (!isMyTurn) {
    // Shouldn't normally get an ACTION here, but guard anyway
    return sendGameState(res, game, player, []);
  }

  if (game.pendingBuy !== null && game.pendingBuy !== undefined && buyChoice !== undefined) {
    return handleBuyDecision(res, game, player, buyChoice);
  }

  if (action === '1') return rollDiceAndMove(res, game, player);
  if (action === '2') return announcePersonalStatus(res, game, player);
  if (action === '3') return handleBuildHouses(res, game, player);
  if (action === '4') return endTurn(res, game, player);

  // Shouldn't be reachable since `allowed` restricts input to 1-4, but keep
  // a safe fallback that re-shows the menu without an error tone.
  return sendGameState(res, game, player, []);
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
        player.lastSeenSeq = game.logSeq;
        await saveGame(game.code, game);
        const t = await msg('s1020', `הטלתם ${d1} ו${d2}. נשארתם בכלא`);
        res.status(200).send(
          respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
        );
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
      player.lastSeenSeq = game.logSeq;
      await saveGame(game.code, game);
      const t = await msg('s1021', 'שלוש פעמים דאבל ברציפות. אתם נשלחים לכלא');
      res.status(200).send(
        respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
      );
      return;
    }
  } else {
    player.doublesStreak = 0;
  }

  const steps = d1 + d2;
  const oldPos = player.pos;
  player.pos = (player.pos + steps) % board.squares.length;
  const passedGo = player.pos <= oldPos && !player.inJail;
  if (passedGo) player.money += board.goMoney;

  const square = squareAt(player.pos);
  await broadcastLog(game, `${player.name} הטיל ${d1} ו${d2} ונחת על ${square.name}`);

  const diceMsg = await msg('sDICE', `הטלתם ${d1} ו${d2}. נחתתם על ${square.name}`);
  const segments = [diceMsg];
  if (passedGo) segments.push(await msg('s1022', `עברתם בהתחלה וקיבלתם ${board.goMoney} שקלים`));

  return resolveSquare(res, game, player, square, segments);
}

function sendToJail(player) {
  player.pos = 10;
  player.inJail = true;
  player.jailTurns = 0;
}

async function resolveSquare(res, game, player, square, segments) {
  if (square.type === 'gotojail') {
    sendToJail(player);
    segments.push(await msg('s1023', 'נחתתם על לך לכלא. אתם נשלחים לכלא'));
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    res.status(200).send(
      respond(segments, { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

  if (square.type === 'tax') {
    player.money -= square.amount;
    await broadcastLog(game, `${player.name} שילם מס בסך ${square.amount} שקלים`);
    segments.push(await msg('sTAX', `שילמתם מס בסך ${priceText(square.amount)}`));
    return checkBankruptcyThenContinue(res, game, player, segments);
  }

  if (['go', 'jail', 'parking', 'chest', 'chance'].includes(square.type)) {
    segments.push(await msg('sFREE', 'משבצת זו אינה דורשת פעולה'));
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    res.status(200).send(
      respond(segments, { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

  // property / railroad / utility
  const owner = game.owners[square.i];
  if (!owner) {
    game.pendingBuy = square.i;
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    const t = await msg('sBUY', `הנכס ${square.name} פנוי לקנייה במחיר ${priceText(square.price)}. לקנייה הקישו אחת. לוותר הקישו שתיים`);
    res.status(200).send(
      respond([...segments, t], { readParams: menuReadParams({ name: 'BUYCHOICE', allowed: '12' }) })
    );
    return;
  }

  if (owner === player.id) {
    segments.push(await msg('sOWN', 'זהו נכס שלכם'));
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    res.status(200).send(
      respond(segments, { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

  if (game.mortgaged[square.i]) {
    segments.push(await msg('sMORTG', 'הנכס ממושכן ולא נגבית עליו שכירות'));
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    res.status(200).send(
      respond(segments, { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

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
  if (player.money < 0) liquidateIfNeeded(game, player);

  if (player.money < 0) {
    player.bankrupt = true;
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
    if (remaining.length === 1) {
      await broadcastLog(game, `${remaining[0].name} הוא המנצח במשחק`);
      segments.push(await msg('sWIN', `${remaining[0].name} הוא המנצח במשחק! ברכותינו`));
    }
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    res.status(200).send(respond(segments, { extra: 'go_to_folder=/' }));
    return;
  }

  player.lastSeenSeq = game.logSeq;
  await saveGame(game.code, game);
  res.status(200).send(
    respond(segments, { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
  );
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
      player.lastSeenSeq = game.logSeq;
      await saveGame(game.code, game);
      res.status(200).send(
        respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
      );
      return;
    }
    player.money -= square.price;
    game.owners[sqIndex] = player.id;
    await broadcastLog(game, `${player.name} קנה את ${square.name}. עלות ${square.price} שקלים`);
    const t = await msg('sBOUGHT', `קניתם את ${square.name} תמורת ${priceText(square.price)}`);
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    res.status(200).send(
      respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

  await broadcastLog(game, `${player.name} ויתר על קניית ${square.name}`);
  const t = await msg('sSKIP', 'ויתרתם על קניית הנכס');
  player.lastSeenSeq = game.logSeq;
  await saveGame(game.code, game);
  res.status(200).send(
    respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
  );
}

async function announcePersonalStatus(res, game, player) {
  const owned = Object.keys(game.owners)
    .filter((k) => game.owners[k] === player.id)
    .map((k) => squareAt(Number(k)).name);
  const propsText = owned.length ? owned.join(', ') : 'אין נכסים';
  const t1 = await msg('sSTATUS1', `יש לכם ${player.money} שקלים`);
  const t2 = await msg('sSTATUS2', `הנכסים שלכם הם: ${propsText}`);
  res.status(200).send(
    respond([t1, t2], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
  );
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
    res.status(200).send(
      respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

  const sqIndex = buildable[0];
  const square = squareAt(sqIndex);
  const cost = square.houseCost || board.houseCostByGroup[square.group] || 50;
  if (player.money < cost) {
    const t = await msg('sNOMONEYBUILD', 'אין לכם מספיק כסף לבנייה');
    res.status(200).send(
      respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }
  player.money -= cost;
  game.houses[sqIndex] = (game.houses[sqIndex] || 0) + 1;
  const level = game.houses[sqIndex];
  const levelText = level >= 5 ? 'מלון' : `${level} בתים`;
  await broadcastLog(game, `${player.name} בנה על ${square.name}, כעת יש ${levelText}`);
  const t = await msg('sBUILT', `בניתם על ${square.name}. עלות ${priceText(cost)}. כעת יש שם ${levelText}`);
  player.lastSeenSeq = game.logSeq;
  await saveGame(game.code, game);
  res.status(200).send(
    respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
  );
}

async function endTurn(res, game, player) {
  if (player.doublesStreak > 0 && !player.inJail) {
    player.doublesStreak = 0;
    player.lastSeenSeq = game.logSeq;
    await saveGame(game.code, game);
    const t = await msg('sAGAIN', 'הטלתם דאבל, אתם משחקים שוב');
    res.status(200).send(
      respond([t], { readParams: menuReadParams({ name: 'ACTION', allowed: '1234' }) })
    );
    return;
  }

  let next = (game.turn + 1) % game.players.length;
  while (game.players[next].bankrupt) {
    next = (next + 1) % game.players.length;
  }
  game.turn = next;
  const nextPlayer = game.players[next];
  await broadcastLog(game, `עובר תור ל${nextPlayer.name}`);

  player.lastSeenSeq = game.logSeq;
  await saveGame(game.code, game);

  const t = await msg('sENDTURN', `סיימתם את תורכם. התור עובר ל${nextPlayer.name}`);
  // The player who just finished waits (hold music) until their next turn.
  res.status(200).send(respond([t], { hold: waitAction() }));
}
