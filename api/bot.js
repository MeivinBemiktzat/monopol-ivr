'use strict';
const board = require('./board.json');
const cards = require('./cards.json');
const roll = () => 1 + Math.floor(Math.random() * 6);
const sqAt = n => board.squares[((n % 40) + 40) % 40];
function note(game, text) {
  game.logSeq++;
  game.log.push({seq: game.logSeq, text});
  if (game.log.length > 100) game.log.shift();
}
function groupOwned(game, bot, group) {
  const list = board.squares.filter(s => s.type === 'property' && s.group === group);
  return list.length > 0 && list.every(s => game.owners[s.i] === bot.id);
}
function netWorth(game, p) {
  return p.money + board.squares.filter(s => game.owners[s.i] === p.id)
    .reduce((sum,s) => sum + (game.mortgaged[s.i] ? Math.floor(s.price/2) : s.price) +
      (game.houses[s.i] || 0) * (s.houseCost || 50), 0);
}
function bankruptcy(game, bot) {
  if (bot.money >= 0) return;
  // Try mortgaging before declaring bankruptcy.
  for (const s of board.squares.filter(s => game.owners[s.i] === bot.id && !game.mortgaged[s.i])) {
    if (bot.money >= 0) break;
    if ((game.houses[s.i] || 0) > 0) continue;
    game.mortgaged[s.i] = true;
    bot.money += Math.floor(s.price / 2);
    note(game, `${bot.name} מישכן את ${s.name}`);
  }
  if (bot.money >= 0) return;
  bot.bankrupt = true;
  for (const [i, owner] of Object.entries(game.owners)) if (owner === bot.id) {
    delete game.owners[i]; delete game.houses[i]; delete game.mortgaged[i];
  }
  note(game, `${bot.name} פשט את הרגל`);
}
function charge(game, bot, amount, text) {
  bot.money -= amount;
  note(game, `${bot.name}: ${text} ${amount} שקלים`);
  bankruptcy(game, bot);
}
function land(game, bot, dice, depth = 0) {
  if (depth > 3 || bot.bankrupt) return;
  const square = sqAt(bot.pos);
  if (square.type === 'gotojail') {
    bot.pos = 10; bot.inJail = true; bot.jailTurns = 0; bot.doublesStreak = 0;
    note(game, `${bot.name} נשלח לכלא`);
    return;
  }
  if (square.type === 'tax') return charge(game, bot, square.amount, 'שילם מס');
  if (square.type === 'chance' || square.type === 'chest') {
    const deck = cards[square.type] || [];
    const card = deck[Math.floor(Math.random() * deck.length)];
    if (!card) return;
    note(game, `${bot.name} קיבל ${square.name}: ${card.text}`);
    if (card.type === 'money') { bot.money += card.amount; bankruptcy(game, bot); }
    if (card.type === 'getoutfree') bot.getOutFree = (bot.getOutFree || 0) + 1;
    if (card.type === 'gotojail') {
      bot.pos = 10; bot.inJail = true; bot.jailTurns = 0; bot.doublesStreak = 0;
    }
    if (card.type === 'move') {
      const prev = bot.pos;
      bot.pos = ((card.to % 40) + 40) % 40;
      if (card.passGo !== false && (bot.pos < prev || card.to === 0)) bot.money += board.goMoney;
      land(game, bot, dice, depth + 1);
    }
    return;
  }
  if (!['property','railroad','utility'].includes(square.type)) return;
  const owner = game.owners[square.i];
  if (!owner) {
    // Preserve cash for rent and taxes; favor completing color sets.
    const ownedGroup = square.group && board.squares.some(s => s.group === square.group && game.owners[s.i] === bot.id);
    const reserve = ownedGroup ? 60 : 150;
    if (bot.money >= square.price + reserve) {
      bot.money -= square.price;
      game.owners[square.i] = bot.id;
      note(game, `${bot.name} קנה את ${square.name} תמורת ${square.price} שקלים`);
    } else note(game, `${bot.name} ויתר על קניית ${square.name}`);
    return;
  }
  if (owner === bot.id || game.mortgaged[square.i]) return;
  let rent = 0;
  if (square.type === 'railroad') {
    const count = board.squares.filter(s => s.type === 'railroad' && game.owners[s.i] === owner).length;
    rent = square.rent[Math.max(0, Math.min(count - 1, square.rent.length - 1))];
  } else if (square.type === 'utility') {
    const count = board.squares.filter(s => s.type === 'utility' && game.owners[s.i] === owner).length;
    rent = dice * (count >= 2 ? 10 : 4);
  } else {
    const houses = game.houses[square.i] || 0;
    rent = square.rent[Math.min(houses, square.rent.length - 1)];
    if (houses === 0 && groupOwned(game, {id: owner}, square.group)) rent *= 2;
  }
  bot.money -= rent;
  const recipient = game.players.find(p => p.id === owner);
  if (recipient) recipient.money += rent;
  note(game, `${bot.name} שילם שכירות ${rent} שקלים על ${square.name}`);
  bankruptcy(game, bot);
}
function build(game, bot) {
  const owned = board.squares.filter(s => s.type === 'property' &&
    game.owners[s.i] === bot.id && groupOwned(game, bot, s.group) && !game.mortgaged[s.i]);
  for (const s of owned) {
    const group = board.squares.filter(x => x.type === 'property' && x.group === s.group);
    const levels = group.map(x => game.houses[x.i] || 0);
    const level = game.houses[s.i] || 0;
    const cost = s.houseCost || board.houseCostByGroup[s.group];
    if (level < 5 && level === Math.min(...levels) && bot.money >= cost + 200) {
      bot.money -= cost;
      game.houses[s.i] = level + 1;
      note(game, `${bot.name} בנה ${level === 4 ? 'מלון' : 'בית'} ב${s.name}`);
      break;
    }
  }
}
function nextTurn(game) {
  for (let k = 0; k < game.players.length; k++) {
    game.turn = (game.turn + 1) % game.players.length;
    if (!game.players[game.turn].bankrupt) break;
  }
  game.turnStartedAt = Date.now();
  const next = game.players[game.turn];
  next.hasRolled = false; next.extraRoll = false; next.doublesStreak = 0;
}
function playOneBot(game) {
  const bot = game.players[game.turn];
  if (!bot || !bot.isBot || game.over) return false;
  note(game, `התור של ${bot.name} מתחיל`);
  build(game, bot);
  let streak = 0;
  for (let attempt = 0; attempt < 3 && !bot.bankrupt; attempt++) {
    const d1 = roll(), d2 = roll(), total = d1 + d2, double = d1 === d2;
    note(game, `${bot.name} הטיל ${d1} ו${d2}`);
    const leavingJail = bot.inJail;
    if (bot.inJail) {
      if (double || bot.getOutFree > 0 || bot.jailTurns >= 2) {
        if (!double && bot.getOutFree > 0) bot.getOutFree--;
        else if (!double) bot.money -= board.jailFine;
        bot.inJail = false; bot.jailTurns = 0;
        bankruptcy(game, bot);
        if (bot.bankrupt) break;
      } else {
        bot.jailTurns++;
        note(game, `${bot.name} נשאר בכלא`);
        break;
      }
    }
    if (double) streak++;
    else streak = 0;
    if (streak >= 3) {
      bot.pos = 10; bot.inJail = true; bot.jailTurns = 0;
      note(game, `${bot.name} הטיל שלושה דאבלים ונשלח לכלא`);
      break;
    }
    const before = bot.pos;
    bot.pos = (bot.pos + total) % 40;
    bot.lastDiceTotal = total;
    if (before + total >= 40) bot.money += board.goMoney;
    note(game, `${bot.name} התקדם ${total} משבצות ונחת על ${sqAt(bot.pos).name}`);
    land(game, bot, total);
    if (!double || leavingJail || bot.inJail) break;
  }
  build(game, bot);
  const alive = game.players.filter(p => !p.bankrupt);
  if (alive.length <= 1) {
    game.over = true;
    if (alive[0]) note(game, `${alive[0].name} ניצח במשחק`);
    return true;
  }
  nextTurn(game);
  note(game, `עובר תור ל${game.players[game.turn].name}`);
  return true;
}
module.exports = { playOneBot, netWorth };
