"use strict";

/* TODO: render latest turn only when switching games, instead of rendering all
in turn. May need to implement something on the server to retrieve the current
turn number. */
/* TODO: store game passwords in cookies */
/* TODO: prettier game list & turn list; highlight current game/turn */

let $gameArea, $gameList, currentGame, gamePasses = [];

$(() => {
	$gameArea = $("#gameArea");
	$gameList = $("#gameList ul");
	$gameArea.on('contextmenu', (e) => { e.preventDefault() });

	$("#gameListRefresh").click(refreshGameList);
	refreshGameList();
});

const refreshGameList = async () => {
	const games = await $.getJSON("server/games");

	$gameList.empty();

	for(const g of games) {
		/* TODO: race condition for display of "watchable"/"playable", if
		the response from newGame() is received after the gameLister entry.
		*/
		const label = `${g.id} (${g.dims[0]}x${g.dims[1]}, ${g.mines}, ` +
				`${gamePasses[g.id] ? "playable" : "watchable"})`;
		$gameList.append($("<li>")
			.text(label)
			.click(() => { displayGame(g, gamePasses[g.id]); })
		);
	}
}

const newGame = () => {
	const getVal = (id, defaultVal) => {
		return parseInt($(`#${id}`).val(), 10) || defaultVal;
	}

	const x = getVal(`dims0`, 10);
	const y = getVal(`dims1`, 10);
	const mines = getVal(`mineCount`, 10);
	const pass = Math.random().toString(36).substr(2, 10);

	serverAction(
		"new",
		{ dims: [x, y], mines: mines, pass: pass },
		resp => {
			gamePasses[resp.id] = pass;
			displayGame(resp, pass);
		}
	);
};

const displayGame = (gameData, pass) => {
	currentGame && currentGame.close();
	currentGame = new ClientGame(
		gameData.id,
		gameData.dims,
		gameData.mines,
		pass,
		true
	);
}

/* Display JSON data in the specified page element. Content is passed in a
wrapper function to allow for error handling. */
const displayDebug = ($elm, contentGetter) => {
	let debugObj, contents;

	try {
		debugObj = contentGetter();
	/* If debug for a specific cell/turn doesn't exist, show nothing in the
	HTML element. */
	} catch (e) {
		if(!(e instanceof TypeError))
			throw e;
	}
	if(typeof debugObj !== "undefined")
		contents = new JSONFormatter(debugObj, 1, {hoverPreviewEnabled: true})
			.render();
	else
		contents = "";
	$elm.html(contents);
}

const showMsg = msg => {
	$("#gameInfo").text(msg).show()
}

/* Send a request to the server; optionally perform an action based on the
response. */
const serverAction = async (action, req, respFn) => {
	/* TODO - proper 'fail' handler, once the server gives proper HTTP codes */
	const resp = JSON.parse(
		await $.post('server/' + action, JSON.stringify(req))
	);

	if(resp.error) {
		let errMsg = `Server error: ${resp.error}`;
		if(resp.info)
			errMsg += `\nInfo: ${JSON.stringify(resp.info)}`;
		showMsg(errMsg);
		return;
	}

	if(respFn)
		respFn(resp);
};

const cellState = {
	UNKNOWN : "u",
	FLAGGED : "f"
};

class ClientGame {
	constructor(id, dims, mines, pass, showDebug) {
		if(dims.length !== 2)
			throw new Error("Only 2d games supported");

		$.extend(this, {id, dims, mines, pass, showDebug});

		this.serverWatcher = new EventSource(`server/watch?id=${id}&from=0`);
		this.serverWatcher.addEventListener("message", (resp) => {
			this.updateTurnList(JSON.parse(resp.data));
		});
		showDebug && this.serverWatcher.addEventListener("debug", (resp) => {
			this.updateDebug(JSON.parse(resp.data));
		});

		this.gameTurns = {};
		this.toClearCoords = {};
		this.flaggedCoords = {};
		this.debugInfo = {};
		this.currentTurn = -1;
		this.gameOver = false;

		/* Retrieve turn number from /status, so we know when the final SSE
		 * message has been received */
		serverAction("status", { id: id }, resp => {
			this.latestTurn = resp.turn;
			this.displayTurn(this.latestTurn);
		});

		this.newGameTable();

		$gameArea.append($("<ol>").attr("id", "turnList").addClass("laminate"));
		$gameArea.append(
			$("<div>").attr("id", "debugArea").append(
				$("<div>").attr("id", "debugAreaTurn"),
				$("<div>").attr("id", "debugAreaCell")
			)
		);
	}

	newGameTable() {
		const $gameTable = $("<table>");
		const gameGrid = [];

		for(let i = 0; i < this.dims[0]; i++) {
			gameGrid[i] = [];
			let $row = $("<tr>");
			$gameTable.append($row);

			for(let j = 0; j < this.dims[1]; j++) {
				gameGrid[i][j] = new GameCell(this, [i, j]);
				$row.append(gameGrid[i][j].$elm);
			}
		}

		this.$gameTable = $gameTable;
		this.gameGrid = gameGrid;
	}

	displayTurn(newTurn) {
		/* When loading a new game, don't render anything until data for the
		latest turn has been loaded (and the number of the latest turn is
		retrieved). */
		if(this.latestTurn === undefined || !this.gameTurns[this.latestTurn])
			return;

		this.$gameTable.detach();
		const reverse = newTurn < this.currentTurn;
		const start = (reverse ? newTurn : this.currentTurn) + 1;
		const end = reverse ? this.currentTurn : newTurn;

		/* Reset any highlighted "to clear" cells if going backwards. */
		if(reverse && this.toClearCoords[this.currentTurn]) {
			for (let coords of this.toClearCoords[this.currentTurn])
				this.getCell(coords).changeState('unknown');
		}

		/* Remove flags - even going forwards, in case the client allows
		unflagging between turns. */
		let flaggedList = (
			this.flaggedCoords[this.currentTurn] ||
			this.flaggedCoords[this.currentTurn - 1]
		);

		if(flaggedList) {
			for (let coords of flaggedList)
				this.getCell(coords).changeState('unknown');
		}

		/* Set all cell data between old turn and new turn, or remove it if
		going backwards */
		for (let i = start; i <= end; i++) {
			for (let cellData of this.gameTurns[i]) {
				this.getCell(cellData.coords).changeState(
					reverse ? 'unknown' : cellData.state,
					cellData.surrounding
				);
			}
		}

		/* Set new "to clear" cells */
		if(this.toClearCoords[newTurn]) {
			for (let coords of this.toClearCoords[newTurn])
				this.getCell(coords).changeState('toClear');
		}

		/* Show flagged mines from client's debug. Show previous turn's flags if
		the current turn's debug is unavailable. */
		flaggedList = (
			this.flaggedCoords[newTurn] ||
			this.flaggedCoords[newTurn - 1]
		);

		if(flaggedList) {
			for (let coords of flaggedList)
				this.getCell(coords).changeState('flagged');
		}

		$gameArea.prepend(this.$gameTable);

		displayDebug(
			$("#debugAreaTurn"),
			() => this.debugInfo[newTurn].gameInfo
		);

		/* Remove cell debug display */
		displayDebug($("#debugAreaCell"));

		this.currentTurn = newTurn;
	}

	updateTurnList({turn : turnNumber, newCellData, gameOver, win}) {
		console.log(arguments);
		/* Add turn new data from server to list & GUI */
		this.gameTurns[turnNumber] = newCellData;

		$("#turnList").append($("<li>")
			.click(() => {
				if(this.currentTurn !== turnNumber)
					this.displayTurn(turnNumber);
			})
			.text("Turn")
			.attr("value", turnNumber)
		);

		/* Wait for initial latestTurn value from server before attempting to
		update it */
		if(this.latestTurn !== undefined)
			this.latestTurn = Math.max(this.latestTurn, turnNumber);

		this.displayTurn(turnNumber);

		if(gameOver) {
			this.gameOver = true;
			showMsg(win ? "Win!!!1" : "Lose :(((");
		}
	}

	updateDebug({turnNumber : turn, debug, toClearCoords}) {
		/* How the client indicates a cell is flagged (v. specific to python
		client). */
		const flaggedIndicator = info => info._state === "State.MINE";

		this.debugInfo[turnNumber] = debug;

		this.toClearCoords[turnNumber] = toClearCoords;

		this.flaggedCoords[turnNumber] = [];
		if(debug && debug.cellInfo) {
			$.each(debug.cellInfo, (key, cellInfo) => {
				if(flaggedIndicator(cellInfo))
					this.flaggedCoords[turnNumber].push(cellInfo.coords);
			});
		}
	}

	clearCells(cells) {
		if(cells.length === 0)
			return;

		if(!this.pass)
			throw new Error(`Don't have the password for game '${this.id}'`);

		serverAction("turn", {
			id: this.id,
			pass: this.pass,
			coords: cells.map(c => c.coords)
		});
	}

	getCell([x, y]) {
		return this.gameGrid[x][y];
	}

	get inPlayState() {
		return (
			this.pass &&
			!this.gameOver &&
			this.currentTurn === this.latestTurn
		);
	}

	close() {
		$gameArea.empty();
		$("#gameInfo").hide();
		this.serverWatcher.close();
	}
}

class GameCell {
	constructor(game, coords) {
		this.game = game;
		this.coords = coords;

		this.$elm = $("<td>").addClass("cell laminate");

		this.changeState('unknown');
	}

	get surroundingCells() {
		if(!this._surroundingCells) {
			this._surroundingCells = [];

			for (let i of [-1, 0, 1]) {
				for (let j of [-1, 0, 1]) {
					if(i === 0 && j === 0)
						continue;

					let x = this.coords[0] + i, y = this.coords[1] + j;

					if(
						x < 0 ||
						y < 0 ||
						x > this.game.dims[0] - 1 ||
						y > this.game.dims[1] - 1
					)
						continue;

					this._surroundingCells.push(this.game.getCell([x, y]));
				}
			}
		}

		return this._surroundingCells;
	}

	hover(hoverOn) {
		this.$elm.toggleClass(
			"cellHover",
			hoverOn && this.state === cellState.UNKNOWN
		);
	}

	hoverSurrounding(hoverOn) {
		for(const cell of this.surroundingCells)
			cell.hover(hoverOn);
	}

	clearSurrounding() {
		this.hoverSurrounding(false);

		this.game.clearCells(
			this.surroundingCells.filter(c => c.state === cellState.UNKNOWN)
		);
	}

	get debug() {
		return this.game.debugInfo[this.currentTurn]
			.cellInfo[this.coords.toString()];
	}

	changeState(newStateName, surrCount) {
		const states = {
			flagged : {
				cellState : cellState.FLAGGED,
				class : 'cellFlagged',
				contextmenu : () => { this.changeState('unknown'); },
			},
			mine : {
				class : 'cellMine'
			},
			unknown : {
				cellState : cellState.UNKNOWN,
				class : 'cellUnknown',
				click : () => {
					this.hover(false);
					this.game.clearCells([ this ]);
				},
				contextmenu : () => { this.changeState('flagged'); },
				mouseover : () => { this.hover(true); },
				mouseout : () => { this.hover(false); }
			},
			cleared : {
				cellState : surrCount,
				class : 'cellCleared',
				text : surrCount > 0 ? surrCount : undefined,
				click : surrCount > 0 ? () => {
					this.clearSurrounding();
				} : undefined,
				mouseover : surrCount > 0 ?
					() => { this.hoverSurrounding(true); } : undefined,
				mouseout : surrCount > 0 ?
					() => { this.hoverSurrounding(false); } : undefined
			},
			toClear : {
				class : 'cellToClear'
			}
		};

		const newState = states[newStateName];
		if(!newState)
			throw new Error(`unexpected cell state: "${newStateName}"`);

		/* Reverse any current mouseover effect */
		this.$elm.mouseout();

		this.$elm.off();
		this.$elm.text("");

		for(const s in states) {
			if(states[s] !== newState && states[s].class)
				this.$elm.removeClass(states[s].class);
		}

		this.state = newState.cellState;
		this.$elm.addClass(newState.class);
		this.$elm.text(newState.text);

		/* Apply mouse actions to cell */
		for (let mouseAction of [
			'click',
			'contextmenu',
			'mouseover',
			'mouseout',
			'mouseup'
		]) {
			if(newState[mouseAction]) {
				this.$elm.on(mouseAction, () => {
					if(this.game.inPlayState)
						newState[mouseAction]();
				});
			}
		}

		if(this.game.showDebug) {
			this.$elm.on('click', () => {
				displayDebug($("#debugAreaCell"), () => this.debug);
			});
		}

		/* TODO: this is meant to highlight surrounding cells right after
		clicking an unknown cell. Doesn't work (:hover is false); don't know
		why. */
		// if(this.$elm.is(":hover"))
		// 	this.$elm.mouseover();
	}
}