'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { playOneBot } = require('../api/bot');
const board = require('../api/board.json');
function game(count=1) {
  const human = {id:'p1',name:'שחקן',money:1500,pos:0,bankrupt:false};
  const bots = Array.from({length:count},(_,i)=>({
    id:'p'+(i+2),name:'בוט '+(i+1),isBot:true,money:1500,pos:0,
    inJail:false,jailTurns:0,getOutFree:0,bankrupt:false
  }));
  return {players:[human,...bots],turn:1,started:true,over:false,owners:{},houses:{},mortgaged:{},log:[],logSeq:0};
}
test('one bot completes a turn and hands control back to human',()=>{
  const g=game();assert.equal(playOneBot(g),true);
  assert.equal(g.turn,0);assert.equal(g.players[1].name,'בוט 1');
  assert.ok(g.players[1].pos>=0 && g.players[1].pos<board.squares.length);
  assert.ok(g.log.length>=2);
});
test('five bots can all complete their turns without invalid board positions',()=>{
  const g=game(5);
  for(let i=0;i<5;i++){assert.equal(playOneBot(g),true);}
  assert.equal(g.turn,0);
  assert.equal(g.players.length,6);
  assert.ok(g.players.every(p=>p.pos>=0&&p.pos<40));
});
test('bot respects jail movement and game still advances',()=>{
  const g=game();g.players[1].inJail=true;g.players[1].pos=10;
  playOneBot(g);assert.equal(g.turn,0);
  assert.ok(g.players[1].pos>=0&&g.players[1].pos<40);
});
test('bot can finish a game when human has already gone bankrupt',()=>{
  const g=game();g.players[0].bankrupt=true;
  playOneBot(g);assert.equal(g.over,true);
});
