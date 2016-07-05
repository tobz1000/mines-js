"use strict";
const express = require('express');
const sse = require('express-eventsource');
const _ = require('underscore');
const nd = require('ndarray');
require('coffee-script/register');
const ty = require('assert-type');
const fs = require('fs');
const clArgs = require('command-line-args');
const product = require('./product');

const GAME_ID_LEN = 5;
const PUBLIC_HTML_DIR = 'public';

/* Validation definitions */
const TY_DIMS = ty.arr.ne.of(ty.int.pos);
const TY_COORDS_LIST = ty.arr.ne.of(ty.arr.ne.of(ty.int.nonneg));

const argsList = clArgs([
	{
		name: 'help',
		alias: 'h',
		description: 'Display available command line arguments.',
		type: Boolean
	},
	{ // TODO: consolidate/organise the code activated by this.
		name: 'gamedb',
		alias: 'd',
		description:
			'Save played games to a database, to be replayed or watched. ' +
			'Seems to increase server delay ~25%.',
		type: Boolean
	}
]);

const args = argsList.parse();

if(args.help) {
	console.log(argsList.getUsage());
	process.exit();
}

const MinesError = function(error, info) {
	this.error = error;
	this.info = info;
}

const serverInit = () => {
	const app = express();
	app.use(express.static(PUBLIC_HTML_DIR));
	app.post('/server', responsePoster(serverAction));

	if(args.gamedb) {
		app.use('/games', (req, resp, next) => {
			sseReplayer(gameLister, req, resp, next);
		});
		app.use('/watch', (req, resp, next) => {
			sseReplayer(getGame(req.query.id).broadcaster, req, resp, next);
		});
	}

	app.listen(1066);
}

/* Hacky; uses sse's reconnection replay to get all events from a given
point in history. */
const sseReplayer = (sse, req, resp, next) => {
	if(!req.get('last-event-id') && req.query.from !== undefined)
		req.headers['last-event-id'] = Number(req.query.from) - 1;

	sse.middleware()(req, resp, next);
}

const gameLister = sse({ history : Infinity });
gameLister.sendGames = () => {
	let gameStates = [];
	for(let id in games)
		gameStates.push(games[id].gameState());

	gameLister.send(gameStates);
}

let games = [];

const getGame = id => {
	let game = games[id];
	if(!game)
		throw new Error(`unknown game id: "${id}"`);
	return game;
};

const responsePoster = (actionFn) => {
	/*	TODO: can't figure out how to process multiple requests at once!
		Seems post requests are queued, and a new one isn't started until the
		response for the last one is end()ed. */
	return (req, resp) => {
		let body = "";
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			let responseObj;
			try {
				responseObj = actionFn(JSON.parse(body));
			} catch(e) {
				if(e instanceof SyntaxError)
					responseObj = { error: "malformed JSON request data" };
				else if (e instanceof MinesError) {
					responseObj = e;
					console.log(
						`Problem with client request: ${JSON.stringify(e)}`
					);
				} else {
					console.error(`Unhandled error: ${e.stack}`);
					responseObj = { error: "unknown error" };
				}
			}
			/* TODO: Proper http response codes */
			resp.end(JSON.stringify(responseObj));
		});
	};
};

/* TODO: actual db. */
const db = {
	save : (gameState) => {
		fs.writeFile(`saves/${gameState.id}`, JSON.stringify(gameState));
	},
	load : (id) => {
		return JSON.parse(fs.readFileSync(`saves/${id}`))
	}
};

/* Performs the action requested by a player. Returns the gameState, and
broadcasts it. */
const serverAction = req => {
	let actionName, gameAction, game, coordsToClear;

	const newGameId = () => {
		let id;
		do { /* Avoid game id collision */
			id = Math.random().toString(36).substr(2, GAME_ID_LEN);
		} while(games[id]);
		return id;
	}

	/* Construct a Game and perform initialisation tasks */
	const registerGame = (id, pass, dims, mines, gridArray) => {
		if(games[id])
			throw new Error(`Tried to overwrite game id: "${id}"`);
		game = new Game(id, pass, dims, mines, gridArray);

		/* Add to list of currently active games */
		games[id] = game;

		if(args.gamedb)
		{
			/* Save initial state to db to play again */
			db.save(game.gameState({ showGridArray: true }));

			/* Update broadcasted list of games */
			gameLister.sendGames();
		}
	}

	/* TODO: These can probably inherit a base GameAction class? */
	let actions = {
		newGame : {
			paramChecks : ty.obj.with({
				dims : TY_DIMS,
				mines : ty.int.pos,
				pass : ty.str.ne
			}),
			func : () => {
				registerGame(
					newGameId(),
					req.pass,
					req.dims,
					req.mines
				);
			},
			promptBroadcast : true
		},

		clearCells : {
			paramChecks : ty.obj.with({
				id : ty.str.ne,
				pass :  ty.str.ne,
				coords : TY_COORDS_LIST
			}),
			func : () => {
				/* Record what the client actually requested to clear (without
				auto-cleared zeroes) for game viewing/debug purposes */
				coordsToClear = req.coords;
				game = getGame(req.id);
				if(game.pass !== req.pass)
					throw new MinesError("Incorrect password!");
				game.clearCells(req.coords);
			},
			promptBroadcast : true
		},

		status : {
			paramChecks : ty.obj.with({
				id : ty.str.ne
			}),
			func : () => { game = getGame(req.id); }
		}
	};

	if(args.gamedb){
		actions.loadGame = {
			paramChecks : ty.obj.with({
				id : ty.str.ne
			}),
			func : () => {
				const params = db.load(req.id);
				registerGame(
					newGameId(),
					req.pass,
					params.dims,
					params.mines,
					params.gridArray
				);
			}
		};
	}

	if(!(actionName = req.action))
		throw new MinesError("no action specified",
			{ available_actions: Object.keys(actions) });

	if(!(gameAction = actions[actionName]))
		throw new MinesError("unknown action", {
			requested_action: actionName,
			available_actions: Object.keys(actions)
		});

	/*	Delete action at this point for a less confusing error message
		(when comparing supplied vs required, since the required list won't
		contain "action:string") */
	delete(req.action);
	try {
		ty.Assert(gameAction.paramChecks)(req);
	} catch(e) {
		if(e instanceof ty.TypeAssertionError) {
			throw new MinesError(
				`invalid parameters supplied for action "${actionName}"`,
				{
					required_params : ty.Describe(gameAction.paramChecks),
					supplied_params : req
				}
			);
		}
		else throw e;
	}

	gameAction.func();

	const gameState = game.gameState({ showLastCells: true });

	if(args.gamedb && gameAction.promptBroadcast) {
		/* Pass on any debug info supplied (should be relevant to previous turn)
		*/
		if(gameState.turn > 0) {
			const debugData = {
				turn: gameState.turn - 1,
				toClear: coordsToClear,
				debug: req.debug
			};
			game.broadcaster.send(debugData, 'debug');
		}

		/* Then send result of current turn */
		game.broadcaster.send(gameState);
	}

	return gameState;
}

const Game = function(id, pass, dims, mines, gridArray) {
	const cellState = {
		EMPTY: 'empty',
		MINE: 'mine',
		CLEARED: 'cleared',
		UNKNOWN: 'unknown'
	};

	this.pass = pass;
	const size = dims.reduce((a, b) => a * b);
	const max_mines = size - 1;

	if (mines > max_mines)
		throw new MinesError("too many mines!", {
			requested_size : size,
			max_mines : max_mines,
			requested_mines : mines,
		});

	let gameOver = false;
	let win = false;
	let cellsRem = size - mines;
	/* Information about the last cell(s) cleared */
	let lastUserCells = [];
	let turnCount = 0;

	gridArray = gridArray || _.shuffle(new Array(size)
		.fill(cellState.MINE, 0, mines)
		.fill(cellState.EMPTY, mines, size)
	)
	const gameGrid = nd(gridArray, dims);

	const surroundingCoords = coords => {
		let ret = [];
		for (let offset of product.repeatProduct([-1, 0, 1], coords.length)) {
			// Don't include self
			if(offset.every(c => c == 0))
				continue;

			// Add offset to coords
			const surrCoords = coords.map((val, i) => val + offset[i]);

			// Check all coords are greater than zero, and within grid limits
			if(surrCoords.some((c, i) => c >= dims[i] || c < 0))
				continue;

			ret.push(surrCoords);
		}

		return ret;
	}

	/* Representation of a cell in the grid. gets/sets gameGrid state. */
	const Cell = function(coords) {
		this.surroundCount = () => {
			let surrCount = 0;

			for(let surrCoords of surroundingCoords(coords))
				if(new Cell(surrCoords).getState() === cellState.MINE)
					surrCount++;

			return surrCount;
		}

		this.getState = () => { return gameGrid.get(...coords); };

		this.uncover = () => {
			if(this.getState() === cellState.MINE)
				gameOver = true;

			else if(this.getState() === cellState.EMPTY) {
				gameGrid.set(...coords.concat(cellState.CLEARED));

				if(--cellsRem <= 0) {
					gameOver = true;
					win = true;
				}
			}
		};

		/* Information the player is allowed to know */
		this.userCell = () => {
			let state = this.getState(), surrounding;

			if(gameOver || state === cellState.CLEARED)
				surrounding = this.surroundCount();
			else
				state = cellState.UNKNOWN;

			return {
				coords : coords,
				surrounding : surrounding,
				state : state
			};
		};
	};

	if(args.gamedb)
		this.broadcaster = sse({ history : Infinity });

	/*	Returns game info for the user or database. */
	/* TODO: default parameters not working in Node :( */
	this.gameState = (options) => {
		options = options || {}
		let state = {
			id : id,
			gameOver : gameOver,
			win : win,
			dims : dims,
			mines : mines,
			cellsRem : cellsRem,
			turn : turnCount
		};

		/* Clear lastUserCells after sending. */
		if(options.showLastCells) {
			state.newCellData = lastUserCells;
			lastUserCells = [];
		}

		if(options.showGridArray) {
			state.gridArray = gameGrid.data;
		}

		return state;
	};

	/* TODO: if the player loses, add all mines to lastUserCells */
	this.clearCells = coordsArr => {
		if(gameOver)
			throw new MinesError("Game over!");

		/* Method is destructive, so copy array first */
		coordsArr = coordsArr.slice();

		turnCount++;

		let coords;
		while(coords = coordsArr.pop()) {
			let cell = new Cell(coords);
			if(cell.getState() === cellState.CLEARED)
				continue;

			cell.uncover();

			lastUserCells.push(cell.userCell());
			if(cell.surroundCount() === 0) {
				for(let surrCoords of surroundingCoords(coords)) {
					coordsArr.push(surrCoords);
				}
			}
		}
	}
}

serverInit();
