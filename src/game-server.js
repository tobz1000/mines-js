"use strict";
const _ = require("underscore");
const mg = require("mongoose");
const ndArray = require('ndarray');

const ReqError = require("./error").ReqError;

const coordsType = [ Number ];

/* TODO: refactor Game functionality into methods for GameState (and rename the
latter). */
const GameState = mg.model("GameState", {
	pass : String,
	/* Requested clears and server-automated clears for each turn */
	state :{
		turns : [
			{
				user: [ coordsType ],
				auto: [ coordsType ]
			}
		],
		gameOver : Boolean,
		win : Boolean,
		dims : coordsType,
		mines : Number,
		cellsRem : Number,
		turn : Number,
		grid : [ String ]
	}
});

const gameServerInit = async () => {
	await mg.connect("localhost", "test");
}

const cellState = {
	EMPTY: 'empty',
	MINE: 'mine',
	CLEARED: 'cleared'
};

const newGame = async ({dims: dims, mines: mines, pass: pass}) => {
	const game = new Game({dims: dims, mines: mines});
	const gameState = new GameState({pass: pass, state: game.state});

	gameState.save();

	return {
		id: gameState.id,
		gameOver: game.gameOver,
		win: game.win,
		dims: game.dims,
		mines: game.mines,
		cellsRem: game.cellsRem,
		turn: game.turn
	};
}

const clearCells = async ({id: id, coords: coords}) => {
	(await loadGame(id)).clearCells(coords);
}

const loadGame = async (id, pass) => {
	const gameState = await GameState.findById(id);

	if(gameState.pass && gameState.pass !== pass)
		throw new ReqError("Incorrect password");
}

class Game {
	/* Parameters: either .dims and .mines, or .load to reload a game's state */
	constructor({load: load, dims: dims, mines: mines}) {
		this.state = load || Game.newGameState(dims, mines);
		this.gameGrid = ndArray(this.state.grid, this.state.dims);
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
			mines : mines,
			cellsRem : size - mines,
			turn : 0,
			grid : gridArray
		};
	}

	clearCells(coordsArr) {
		if(state.gameOver)
			throw new ReqError("Game over!");

		const clearedCells = [];
		const coordsStack = coordsArr.slice();

		let coords;
		while(coords = coordsStack.pop()) {
			let cell = new Cell(coords, this.gameGrid);
			if(cell.state === cellState.CLEARED)
				continue;

			cell.uncover();

			clearedCells.push(cell.info);
			if(cell.surroundCount === 0) {
				for(let surrCoords of surroundingCoords(coords)) {
					coordsStack.push(surrCoords);
				}
			}
		}
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
		func : async () => { throw new ReqError("no status 4 u"); }
	}
};

module.exports = {
	init : gameServerInit,
	actions : actions
};
