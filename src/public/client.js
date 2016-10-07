"use strict";

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

const $listItemProp = (type, text) => {
	const { icon, minChars } = {
		id : {
			icon : "fa-hashtag",
			minChars : 24,
		},
		dims : {
			icon : "fa-th",
			minChars : 5,
		},
		mines : {
			icon : "fa-bomb",
			minChars : 2,
		},
		playable : {
			icon : "fa-gamepad"
		},
		watchable : {
			icon : "fa-binoculars"
		},
		clearReq : {
			icon : "fa-paint-brush",
			minChars : 2,
		},
		clearActual : {
			icon : "fa-long-arrow-right",
			minChars : 2,
		},
		percComplete : {
			minChars : 3,
		},
		win : {
			icon : "fa-trophy"
		},
		lose : {
			icon : "fa-bomb"
		}
	}[type];

	const minWidth = (minChars || 0) + (icon ? 2 : 0);
	const $elm = $("<span>");

	if(icon)
		$elm.append(`<i class="fa ${icon}">`);

	if(text)
		$elm.append(text);

	if(minWidth)
		$elm.css({ "min-width" : (minWidth) + "ch" });

	return $elm;
};

const refreshGameList = async () => {
	const games = await $.getJSON("server/games");

	$gameList.empty();

	for(const g of games) {
		/* TODO: race condition for display of "watchable"/"playable", if
		the response from newGame() is received after the gameLister entry.
		*/
		$gameList.append($("<li>")
			.append($listItemProp("id", g.id))
			.append($listItemProp("dims", `${g.dims[0]}x${g.dims[1]}`))
			.append($listItemProp("mines", g.mines))
			.append($listItemProp(gamePasses[g.id] ? "playable" : "watchable"))
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

		this.toFlag = new Set();
		this.toUnflag = new Set();

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

		/* Map received JSON state strings to the corresponding cell.state
		value.*/
		const serverStateMap = {
			"cleared" : "cleared",
			"mine" : "mine"
		};

		this.$gameTable.detach();
		const reverse = newTurn < this.currentTurn;
		const start = (reverse ? newTurn : this.currentTurn) + 1;
		const end = reverse ? this.currentTurn : newTurn;

		/* Reset any highlighted "to clear" cells. */
		if(this.currentTurn !== this.latestTurn) {
			for (let coords of this.gameTurns[this.currentTurn + 1].clearReq)
				this.getCell(coords).$elm.removeClass('cellToClear');
		}

		/* Set all cell data between old turn and new turn, or remove it if
		going backwards */
		for (let i = start; i <= end; i++) {
			for (const cellData of this.gameTurns[i].clearActual) {
				this.getCell(cellData.coords).changeState(
					reverse ? "unknown" : serverStateMap[cellData.state],
					cellData.surrounding
				);
			}

			/* TODO: incorrect to assume unflagging will go to unknown, since
			server allows flagging of cleared cells*/
			for(const coords of this.gameTurns[i].flagged) {
				this.getCell(coords).changeState(
					reverse ? "unknown" : "flagged"
				);
			}

			for(const coords of this.gameTurns[i].unflagged) {
				this.getCell(coords).changeState(
					reverse ? "flagged" : "unknown"
				);
			}
		}

		/* Set new "to clear" cells */
		if(newTurn !== this.latestTurn) {
			for (let coords of this.gameTurns[newTurn + 1].clearReq)
				this.getCell(coords).$elm.addClass('cellToClear');
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

		const listEntryItems = [
			[ "clearReq", `${turn.clearReq.length}` ],
			[ "clearActual", `${turn.clearActual.length}` ]
		];

		if(turn.gameOver)
			listEntryItems.push(turn.win ? [ "win" ] : [ "lose" ])
		else {
			const percComp =
				100 * (1 - (turn.cellsRem / this.gameTurns[0].cellsRem));

			listEntryItems.push([ "percComplete", `${percComp.toFixed()}%` ]);
		}

		const $elm = $(`<li value=${turnNum}>`).click(() => {
			if(this.currentTurn !== turnNum)
				this.displayTurn(turnNum);
		})

		for(const [ type, text ] of listEntryItems)
			$elm.append($listItemProp(type, text));

		$("#turnList").append($elm);

		/* Wait for initial latestTurn value from server before attempting to
		update it */
		if(this.latestTurn !== undefined)
			this.latestTurn = Math.max(this.latestTurn, turnNum);

		this.displayTurn(turnNum);

		this.gameOver |= turn.gameOver;
	}

	updateDebug({turnNumber : turn, debug}) {
		this.debugInfo[turnNumber] = debug;
	}

	/* Clear specified cells, and "flush" flags/unflags to server */
	clearCells(cells) {
		if(cells.length === 0)
			return;

		if(!this.pass)
			throw new Error(`Don't have the password for game '${this.id}'`);

		serverAction("turn", {
			id: this.id,
			pass: this.pass,
			clear: cells.map(c => c.coords),
			flag: Array.from(this.toFlag).map(c => c.coords),
			unflag: Array.from(this.toUnflag).map(c => c.coords),
		});

		this.toFlag.clear();
		this.toUnflag.clear();
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
			hoverOn && this.state === "unknown"
		);
	}

	hoverSurrounding(hoverOn) {
		for(const cell of this.surroundingCells)
			cell.hover(hoverOn);
	}

	clearSurrounding() {
		this.hoverSurrounding(false);

		this.game.clearCells(
			this.surroundingCells.filter(c => c.state === "unknown")
		);
	}

	get debug() {
		return this.game.debugInfo[this.currentTurn]
			.cellInfo[this.coords.toString()];
	}

	toggleFlag(flagUp) {
		const [addSet, removeSet, newState] = flagUp ?
			[this.game.toFlag, this.game.toUnflag, "flagged"] :
			[this.game.toUnflag, this.game.toFlag, "unknown"];

		this.changeState(newState);

		/* Only add to set if not currently in the other set (i.e. flag then
		unflag == no action) */
		if(!removeSet.delete(this))
			addSet.add(this);
	}

	changeState(newStateName, surrCount) {
		const states = {
			flagged : {
				class : 'cellFlagged',
				contextmenu : () => { this.toggleFlag(false); },
			},
			mine : {
				class : 'cellMine'
			},
			unknown : {
				class : 'cellUnknown',
				click : () => {
					this.hover(false);
					this.game.clearCells([ this ]);
				},
				contextmenu : () => { this.toggleFlag(true); },
				mouseover : () => { this.hover(true); },
				mouseout : () => { this.hover(false); }
			},
			cleared : {
				class : 'cellCleared',
				text : surrCount > 0 ? surrCount : undefined,
				click : surrCount > 0 ? () => {
					this.clearSurrounding();
				} : undefined,
				mouseover : surrCount > 0 ?
					() => { this.hoverSurrounding(true); } : undefined,
				mouseout : surrCount > 0 ?
					() => { this.hoverSurrounding(false); } : undefined
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

		this.state = newStateName;
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