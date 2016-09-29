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

	$("#newGame").click(newGame);

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

const newGame = async () => {
	const getVal = (id, defaultVal) => {
		return parseInt($(`#${id}`).val(), 10) || defaultVal;
	}

	const x = getVal(`dims0`, 10);
	const y = getVal(`dims1`, 10);
	const mines = getVal(`mineCount`, 10);
	const pass = Math.random().toString(36).substr(2, 10);

	const resp = await serverAction(
		"new",
		{ dims: [x, y], mines: mines, pass: pass }
	);

	gamePasses[resp.id] = pass;
	displayGame(resp, pass);
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
const serverAction = async (action, req) => {
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

	return resp;
};

const cellState = {
	UNKNOWN : "u",
	FLAGGED : "f"
};

class ClientGame {
	constructor(id, dims, mines, pass, showDebug) {
		if(dims.length !== 2)
			throw new Error("Only 2d games supported");

		/* Add constructor args to the ClientGame */
		$.extend(this, {id, dims, mines, pass, showDebug});

		this.serverWatcher = new EventSource(`server/watch?id=${id}&from=0`);
		this.serverWatcher.addEventListener("message", (resp) => {
			this.updateTurnList(JSON.parse(resp.data));
		});
		showDebug && this.serverWatcher.addEventListener("debug", (resp) => {
			this.updateDebug(JSON.parse(resp.data));
		});

		this.gameTurns = {};
		this.debugInfo = {};
		this.currentTurn = -1;
		this.gameOver = false;

		this.newGameTable();

		$gameArea.append('<ol id="turnList" class="laminate">');
		$gameArea.append(
			$('<div id="debugArea">').append(
				$('<div id="debugAreaTurn">'),
				$('<div id="debugAreaCell">')
			)
		);

		/* Retrieve turn number from /status, so we know when the final SSE
		 * message has been received */
		serverAction("status", { id: id }).then(resp => {
			this.latestTurn = resp.turnNum;
			this.displayTurn(this.latestTurn);
		}).catch(showMsg);
	}

	newGameTable() {
		const $gameTable = $("<table>");
		const gameGrid = [];

		for(let i = 0; i < this.dims[0]; i++) {
			gameGrid[i] = [];
			let $row = $("<tr>");

			for(let j = 0; j < this.dims[1]; j++) {
				gameGrid[i][j] = new GameCell(this, [i, j]);
				$row.append(gameGrid[i][j].$elm);
			}

			$gameTable.append($row);
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
		if(reverse && this.currentTurn !== this.latestTurn) {
			for (let coords of this.gameTurns[this.currentTurn + 1].clearReq)
				this.getCell(coords).changeState('unknown');
		}

		/* Set all cell data between old turn and new turn, or remove it if
		going backwards */
		for (let i = start; i <= end; i++) {
			for (let cellData of this.gameTurns[i].clearActual) {
				this.getCell(cellData.coords).changeState(
					reverse ? 'unknown' : cellData.state,
					cellData.surrounding
				);
			}
		}

		/* Set new "to clear" cells */
		if(newTurn !== this.latestTurn) {
			for (let coords of this.gameTurns[newTurn + 1].clearReq)
				this.getCell(coords).changeState('toClear');
		}

		$gameArea.prepend(this.$gameTable);

		// displayDebug(
		// 	$("#debugAreaTurn"),
		// 	() => this.debugInfo[newTurn].gameInfo
		// );

		// /* Remove cell debug display */
		// displayDebug($("#debugAreaCell"));

		this.currentTurn = newTurn;
	}

	updateTurnList(turn) {
		/* Add turn new data from server to list & GUI */
		const turnNum = turn.turnNum;
		this.gameTurns[turnNum] = turn;

		$("#turnList").append($("<li>")
			.click(() => {
				if(this.currentTurn !== turnNum)
					this.displayTurn(turnNum);
			})
			.text("Turn")
			.attr("value", turnNum)
		);

		/* Wait for initial latestTurn value from server before attempting to
		update it */
		if(this.latestTurn !== undefined)
			this.latestTurn = Math.max(this.latestTurn, turnNum);

		this.displayTurn(turnNum);

		if(turn.gameOver) {
			this.gameOver = true;
			showMsg(this.gameTurns[this.latestTurn].win ? "Win!!!1" : "Lose :(((");
		}
	}

	updateDebug({turnNumber : turn, debug}) {
		/* How the client indicates a cell is flagged (v. specific to python
		client). */
		const flaggedIndicator = info => info._state === "State.MINE";

		this.debugInfo[turnNumber] = debug;

		// this.flaggedCoords[turnNumber] = [];
		// if(debug && debug.cellInfo) {
		// 	$.each(debug.cellInfo, (key, cellInfo) => {
		// 		if(flaggedIndicator(cellInfo))
		// 			this.flaggedCoords[turnNumber].push(cellInfo.coords);
		// 	});
		// }
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
		if(this.state === newStateName)
			return;

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