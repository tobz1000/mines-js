"use strict";
const _ = require("underscore");
const mg = require("mongoose");
const ndArray = require("ndarray");
const sse = require("express-eventsource");
const product = require("./product");

const ReqError = require("./error").ReqError;

mg.Promise = global.Promise;

const cellState = {
	EMPTY: 'empty',
	MINE: 'mine',
	CLEARED: 'cleared',
	FLAGGED: 'flag'
};

const renameIdKey = (doc, ret) => {
	ret.id = ret._id;
	delete ret._id;
}

/* Necessary for returning db results directly to clients */
const schemaOptions = {
	toObject : { transform : renameIdKey },
	toJSON :{ transform : renameIdKey },
};

const coordsType = [ Number ];
const gameSchema = new mg.Schema({
	pass : String,
	dims : coordsType,
	size : Number,
	mines : Number,
	/* Requested clears and actual clears (including automatic zero-surrounding)
	for each turn */
	turns : [
		{
			_id : false,
			clearReq: [ coordsType ],
			clearActual: [
				{
					_id : false,
					coords : coordsType,
					surrounding : Number,
					state : String
				}
			],
			flagged : [ coordsType ],
			unflagged : [ coordsType ],
			gameOver : Boolean,
			win : Boolean,
			cellsRem : Number
		}
	],
	cellArray : [ String ],
	flagArray : [ Boolean ]
}, schemaOptions);

const gameMethods = {
	/* Methods must be fat functions for "this"-binding */
	methods : {
		turn : function({clear, flag, unflag, pass}) {
			if(this.pass && this.pass !== pass)
				throw new ReqError("Incorrect password");

			if(this.gameOver)
				throw new ReqError("Game over!");

			this.turns.push({
				clearReq: clear,
				clearActual: [],
				flagged : undefined,
				unflagged : undefined,
				gameOver : false,
				win : false,
				cellsRem : this.cellsRem
			});

			this.clearCells(clear);
			this.flagCells(flag, unflag);

			this.markModified('cellArray');
			this.markModified('flagArray');
		},

		clearCells : function(coordsArr) {
			const coordsStack = coordsArr.slice();

			let coords;
			while(coords = coordsStack.pop()) {
				const cell = new Cell(this, coords);

				if(cell.state === cellState.CLEARED)
					continue;

				cell.uncover();

				this.clearActual.push(cell.info);

				if(cell.surroundCount === 0) {
					for(let surrCoords of this.surroundingCoords(coords)) {
						coordsStack.push(surrCoords);
					}
				}
			}
		},

		flagCells : function(flag, unflag) {
			for(const [arr, otherArr, toFlag, dest] of [
				[flag, unflag, true, "flagged"],
				[unflag, flag, false, "unflagged"]
			]) {
				/* Set should be quicker for comparing flagged list against
				unflagged*/
				const otherSet = new Set(otherArr);
				const arrActual = arr.filter(c =>
					!otherSet.has(c) &&
					this.flagGrid.get(...c) !== toFlag
				);

				arrActual.forEach(c => this.flagGrid.set(...c, toFlag));

				this[dest] = arrActual;
			}
		},

		surroundingCoords : function(coords) {
			let ret = [];
			const offsets = product.repeatProduct([-1, 0, 1], coords.length);
			for (let offset of offsets) {
				// Don't include self
				if(offset.every(c => c === 0))
					continue;

				// Add offset to coords
				const surrCoords = coords.map((val, i) => val + offset[i]);

				// Check all coords are greater than zero, and within grid limits
				if(surrCoords.some((c, i) => c >= this.dims[i] || c < 0))
					continue;

				ret.push(surrCoords);
			}

			return ret;
		},

		userStateTurn : function(turnNum) {
			if(turnNum > this.turnNum)
			{
				throw new ReqError("turn number too high", {
					requestedTurn : turnNum,
					currentTurn : this.turnNum
				});
			}

			return _.extend({
				id : this.id,
				dims : this.dims,
				mines : this.mines,
				turnNum : turnNum
			}, this.turns[turnNum].toObject());
		},

		getGrid : function(array) {
			if(!this.grids)
				this.grids = new WeakMap();

			if(!this.grids.has(array))
				this.grids.set(array, ndArray(array, this.dims));

			return this.grids.get(array);
		}
	},
	statics : {
		newGameState : ({dims, mines, pass}) => {
			const size = dims.reduce((a, b) => a * b);
			const max_mines = size - 1;

			if(mines >= max_mines) {
				throw new ReqError("too many mines", {
					requestedSize : size,
					maxMines : max_mines,
					requestedMines : mines,
				});
			}

			const cellArray = _.shuffle(new Array(size)
				.fill(cellState.MINE, 0, mines)
				.fill(cellState.EMPTY, mines, size)
			);

			const flagArray = new Array(size).fill(false, size);

			return {
				pass : pass,
				dims : dims,
				size : size,
				mines : mines,
				turns : [
					{
						turnFinished : true,
						clearReq : [],
						clearActual : [],
						gameOver : false,
						win : false,
						cellsRem : size - mines
					}
				],
				cellArray : cellArray,
				flagArray : flagArray
			};
		}
	},
};

/* Virtuals must be fat functions for "this"-binding */
const gameVirtuals = {
	cellGrid : function(){
		return this.getGrid(this.cellArray);
	},

	flagGrid : function(){
		return this.getGrid(this.flagArray);
	},

	userState : function() {
		return this.userStateTurn(this.turnNum);
	},

	turnNum : function() {
		return this.turns.length - 1;
	}
};

_.extend(gameSchema, gameMethods);
_.each(gameVirtuals, (fn, name) => {
	gameSchema.virtual(name).get(fn);
});
/*
 * Allows accessing properties of latest turn from root of schema, e.g.
 * "game.gameOver" instead of "game.turns[game.turnNum - 1].gameOver".
 */
_.each(gameSchema.tree.turns[0], (type, key) => {
	if(key === "_id")
		return;

	gameSchema.virtual(key).get(function() {
		return this.turns[this.turnNum][key];
	}).set(function(val) {
		this.turns[this.turnNum][key] = val;
	});
})

const Game = mg.model("Game", gameSchema);

const gameServerInit = async () => {
	if(!gameServerInit.connect)
		gameServerInit.connect = mg.connect("localhost", "test");

	await gameServerInit.connect;
}

const loadGame = async (id) => {
	if(!id)
		throw new ReqError("no game id supplied");

	try {
		const game = await Game.findById(id);
	} catch(e) {
		if(e instanceof mg.CastError)
			throw new ReqError("invalid game id", { requestedId : id })
		else
			throw e;
	}

	if(!game)
		throw new ReqError("unknown game id", { requestedId : id });

	return game;
};

const newGame = async (params) => {
	const game = new Game(Game.newGameState(params));

	game.save();

	return game.userState;
}

const listGames = () => {
	return Game.find({}, "id dims mines");
}

const gameState = async ({id, turn}) => {
	const game = await loadGame(id);
	return game.userStateTurn(turn || game.turnNum);
};

const turn = async (params) => {
	const game = await loadGame(params.id);

	game.turn(params);
	game.save();

	const state = game.userState;

	if(watchGame[params.id])
		watchGame[params.id].send(state);

	return state;
};

const watchGame = async ({id}) => {
	const game = await loadGame(id);

	/* TODO: delete sse when all connections are closed */
	if(!watchGame[id])
	{
		watchGame[id] = sse({ history : Infinity });

		for(let i of _.range(game.turns.length))
			watchGame[id].send(game.userStateTurn(i));
	}

	return watchGame[id];
}

/* Representation of a cell in the grid. gets/sets cellGrid state. */
class Cell {
	constructor(game, coords) {
		this.coords = coords;
		this.game = game;
	}

	get surroundCount() {
		let surrCount = 0;

		for(let surrCoords of this.game.surroundingCoords(this.coords)){
			if(new Cell(this.game, surrCoords).state === cellState.MINE)
				surrCount++;
		}

		return surrCount;
	}

	get state() {
		return this.game.cellGrid.get(...this.coords);
	}

	get info() {
		return {
			coords : this.coords,
			surrounding : this.surroundCount,
			state : this.state
		};
	}

	uncover() {
		if(this.state === cellState.MINE) {
			this.game.gameOver = true;
			return;
		}

		if(this.state === cellState.EMPTY) {
			this.game.cellGrid.set(...this.coords, cellState.CLEARED);

			if(--this.game.cellsRem <= 0) {
				this.game.gameOver = true;
				this.game.win = true;
			}
		}
	}
};

module.exports = {
	init : gameServerInit,
	actions : {
		new : {
			// schema : newGameSchema,
			// returnSchema : gameStateSchema,
			type : "post",
			handler : newGame
		},
		turn : {
			// schema : clearCellsSchema,
			// returnSchema : gameStateSchema,
			type : "post",
			handler : turn
		},
		status : {
			type : "post",
			handler : gameState
		},
		watch : {
			type : "sse",
			handler : watchGame
		},
		games : {
			type : "post",
			handler : listGames
		}
	}
};
