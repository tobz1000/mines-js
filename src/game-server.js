"use strict";
const _ = require("underscore");
const mg = require("mongoose");
const ndArray = require('ndarray');

const ReqError = require("./error").ReqError;

const cellState = {
	EMPTY: 'empty',
	MINE: 'mine',
	CLEARED: 'cleared'
};

const coordsType = [ Number ];
const gameSchema = new mg.Schema({
	pass : String,
	/* Requested clears and actual clears (including zero-surround) for each
	turn */
	turns : [
		{
			user: [ coordsType ],
			actual: [ coordsType ]
		}
	],
	gameOver : Boolean,
	win : Boolean,
	dims : coordsType,
	mines : Number,
	cellsRem : Number,
	turn : Number,
	gridArray : [ String ]
});

const gameMethods = {
	methods : {
		clearCells : (coordsArr, pass) => {
			if(this.pass && this.pass !== pass)
				throw new ReqError("Incorrect password");

			if(state.gameOver)
				throw new ReqError("Game over!");

			const turn = {
				user: coordsArr,
				actual: []
			};

			/* Info about cleared cells */
			const ret = [];
			const coordsStack = coordsArr.slice();

			let coords;
			while(coords = coordsStack.pop()) {
				let cell = new Cell(coords, this.gameGrid);
				if(cell.state === cellState.CLEARED)
					continue;

				cell.uncover();

				turn.actual.push(coords);
				ret.push(cell.info);

				if(cell.surroundCount === 0) {
					for(let surrCoords of surroundingCoords(coords)) {
						coordsStack.push(surrCoords);
					}
				}
			}

			this.turns.push(turn);
			this.turn++;
			return ret;
		}
	},
	statics : {
		newGameState : ({dims, mines, pass}) => {
			const size = dims.reduce((a, b) => a * b);
			const max_mines = size - 1;

			if (mines > max_mines) {
				throw new ReqError("too many mines!", {
					requestedSize : size,
					maxMines : max_mines,
					requestedMines : mines,
				});
			}

			const gridArray = _.shuffle(new Array(size)
				.fill(cellState.MINE, 0, mines)
				.fill(cellState.EMPTY, mines, size)
			);

			return {
				pass : pass,
				turns : [],
				gameOver : false,
				win : false,
				dims : dims,
				size : size,
				mines : mines,
				cellsRem : size - mines,
				turn : 0,
				gridArray : gridArray
			};
		}
	},
}

/* Virtuals must be fat functions for "this"-binding */
const gameVirtuals = {
	gameGrid : function() {
		if(!this._gameGrid)
			this._gameGrid = ndArray(this.gridArray, this.dims);

		return this._gameGrid;
	},

	userState : function() {
		return {
			id : this.id,
			// TODO: seed parameter
			gameOver : this.gameOver,
			win : this.win,
			dims : this.dims,
			mines : this.mines,
			cellsRem : this.cellsRem,
			turn : this.turn,
		};
	}
}

_.extend(gameSchema, gameMethods);
_.each(gameVirtuals, (fn, name) => {
	gameSchema.virtual(name).get(fn);
});

const Game = mg.model("Game", gameSchema);

const gameServerInit = async () => {
	await mg.connect("localhost", "test");
}

const newGame = async (params) => {
	const game = new Game(Game.newGameState(params));

	game.save();

	return game.userState;
}

const clearCells = async ({id, coords, pass}) => {
	const game = await loadGame(id);
	const newCells = game.clearCells(coords, pass);

	game.save();

	const state = game.usetState;
	state.newCellData = newCells;
	return state;
};

const gameState = async ({id}) => {
	const s = await loadGame(id);
	return s.userState;
};

/* TODO: problem: this will return a new GameModel, not a Game. Might have to
use mongoose's method & virtual property mechanisms instead of class syntax :(
*/
const loadGame = (id) => {
	return Game.findById(id);
};

/* Representation of a cell in the grid. gets/sets gameGrid state. */
class Cell {
	constructor(coords, gameGrid) {
		this.coords = coords;
		this.gameGrid = gameGrid;
	}

	get surroundCount() {
		let surrCount = 0;

		for(let surrCoords of surroundingCoords(this.coords)){
			if(new Cell(surrCoords, this.gameGrid).state === cellState.MINE)
				surrCount++;
		}

		return surrCount;
	}

	get state() {
		return this.gameGrid.get(...this.coords);
	}

	get info() {
		return {
			coords : this.coords,
			surrounding : this.surroundCount,
			state : this.state
		};
	}

	uncover() {
		if(this.state === cellState.EMPTY)
			this.gameGrid.set(...this.coords.concat(cellState.CLEARED));
	}
};

const actions = {
	newGame : {
		// schema : newGameSchema,
		// returnSchema : gameStateSchema,
		func : newGame
	},
	clearCells : {
		// schema : clearCellsSchema,
		// returnSchema : gameStateSchema,
		func : clearCells
	},
	status : {
		func : gameState
	}
};

module.exports = {
	init : gameServerInit,
	actions : actions
};
