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
const GameModel = mg.model("Game", {
	pass : String,
	/* Requested clears and actual clears (including zero-surround) for each
	turn */
	state : {
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
	}
});

const gameServerInit = async () => {
	await mg.connect("localhost", "test");
}

const newGame = async (params) => {
	const game = new Game(params);

	game.save();

	return game.userState;
}

const clearCells = async ({id, coords, pass}) => {
	const game = await loadGame(id, pass);

	if(game.pass && game.pass !== pass)
		throw new ReqError("Incorrect password");

	const newCells = game.clearCells(coords);

	game.save();

	const state = game.gameState;
	state.newCellData = newCells;

	return state;
}

const gameState = async ({id}) => {
	const s = await loadGame(id);
	console.log(s);
	return s.gameState;
}

/* TODO: problem: this will return a new GameModel, not a Game. Might have to
use mongoose's method & virtual property mechanisms instead of class syntax :(
*/
const loadGame = (id) => {
	return Game.findById(id);
}

class Game extends GameModel {
	/* Parameters: either .dims and .mines, or .load to reload a game's state */
	constructor(params) {
		if(params)
		{
			const {dims, mines, pass} = params;
			super({
				pass: pass,
				state: Game.newGameState(dims, mines)
			});
		}
		else
			super(arguments);
	}

	static newGameState(dims, mines) {
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

	get gameGrid() {
		if(!this._gameGrid)
			this._gameGrid = ndArray(this.state.gridArray, this.state.dims);

		return this._gameGrid;
	}

	/* Number of current turn (starting at 0) */
	get turn() {
		return this.state.turns.length;
	}

	get userState() {
		return {
			id : this.id,
			// TODO: seed parameter
			gameOver : this.state.gameOver,
			win : this.state.win,
			dims : this.state.dims,
			mines : this.state.mines,
			cellsRem : this.state.cellsRem,
			turn : this.turn,
		};
	}

	clearCells(coordsArr, pass) {
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
		return ret;
	}
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
