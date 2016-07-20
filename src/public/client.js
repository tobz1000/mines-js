"use strict";

/* TODO: render latest turn only when switching games, instead of rendering all
in turn. May need to implement something on the server to retrieve the current
turn number. */
/* TODO: store game passwords in cookies */
/* TODO: prettier game list & turn list; highlight current game/turn */

let $gameArea, $gameList, currentGame, gamePasses = [];

$(() => {
	$gameArea = $("#gameArea");
	$gameList = $("#gameList");
	$gameArea.on('contextmenu', (e) => { e.preventDefault() });

	new EventSource(`games?from=0`)
		.addEventListener('message', refreshGameList);
});

const refreshGameList = resp => {
	$gameList.empty();

	for(const g of JSON.parse(resp.data)) {
		/* TODO: race condition for display of "watchable"/"playable", if the
		response from newGame() is received after the gameLister entry. */
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
		{ action: 'newGame', dims: [x, y], mines: mines, pass: pass },
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
const serverAction = (req, respFn) => {
	/* TODO - proper 'fail' handler, once the server gives proper HTTP codes */
	$.post('server', JSON.stringify(req), resp => {
		if(resp.error) {
			let errMsg = `Server error: ${resp.error}`;
			if(resp.info)
				errMsg += `\nInfo: ${JSON.stringify(resp.info)}`;
			showMsg(errMsg);
			return;
		}

		if(respFn)
			respFn(resp);
	}, 'json');
};

/* Optional 'pass' param if game is controllable */
const ClientGame = function(id, dims, mines, pass, debug) {
	const cellState = {
		UNKNOWN : "u",
		FLAGGED : "f"
	}

	const serverWatcher = new EventSource(`watch?id=${id}&from=0`);

	/* Representation of game state; each cell is a 'GameCell'. */
	const gameGrid = [];
	/* List of lists of cellDatas, to represent each turn in the game. */
	const gameTurns = {};
	/* Retroactive list of cells the client intended to clear next, for each
	previous turn in the game. */
	const toClearCoords = {};
	/* Retroactive list of flagged cells, extracted from client debug. Info from
	last available turn is used for latest turn, since latest turn's debug won't
	be available. */
	/* TODO: refactor this and toClearCoords into a table of info for "flagged"
	and "toClear", sharing code functionality. */
	const flaggedCoords = {};
	/* Debug info for each turn */
	const debugInfo = {};
	let currentTurn = -1;
	let latestTurn;
	let gameOver = false;

	serverAction(
		{ action: 'status', id: id },
		resp => {
			latestTurn = resp.turn;
			displayTurn(latestTurn);
		}
	)

	const displayTurn = newTurn => {
		/* When loading a new game, don't render anything until data for the
		latest turn has been loaded (and the number of the latest turn is
		retrieved). */
		if(latestTurn === undefined || !gameTurns[latestTurn])
			return;

		$gameTable.detach();
		const reverse = newTurn < currentTurn;
		const start = (reverse ? newTurn : currentTurn) + 1;
		const end = reverse ? currentTurn : newTurn;

		/* Reset any highlighted "to clear" cells if going backwards. */
		if(reverse && toClearCoords[currentTurn]) {
			for (let coords of toClearCoords[currentTurn])
				getCell(coords).changeState('unknown');
		}

		/* Remove flags - even going forwards, in case the client allows
		unflagging between turns. */
		let flaggedList = (
			flaggedCoords[currentTurn] ||
			flaggedCoords[currentTurn - 1]
		);
		if(flaggedList) {
			for (let coords of flaggedList)
				getCell(coords).changeState('unknown');
		}

		/* Set all cell data between old turn and new turn, or remove it if
		going backwards */
		for (let i = start; i <= end; i++) {
			for (let cellData of gameTurns[i]) {
				getCell(cellData.coords).changeState(
					reverse ? 'unknown' : cellData.state,
					cellData.surrounding
				);
			}
		}

		/* Set new "to clear" cells */
		if(toClearCoords[newTurn]) {
			for (let coords of toClearCoords[newTurn])
				getCell(coords).changeState('toClear');
		}

		/* Show flagged mines from client's debug. Show previous turn's flags if
		the current turn's debug is unavailable. */
		flaggedList = (flaggedCoords[newTurn] || flaggedCoords[newTurn - 1]);
		if(flaggedList) {
			for (let coords of flaggedList)
				getCell(coords).changeState('flagged');
		}

		$gameArea.prepend($gameTable);

		displayDebug(
			$("#debugAreaTurn"),
			() => debugInfo[newTurn].gameInfo
		);

		/* Remove cell debug display */
		displayDebug($("#debugAreaCell"));

		currentTurn = newTurn;
	}

	/* Perform a turn: send request to server */
	/* TODO: send list of currently flagged cell to server, so they can be
	displayed properly when the game is played back. */
	const clearCells = coordsArr => {
		if(!pass)
			throw new Error(`Don't have the password for game '${id}'`);

		serverAction({
			action : 'clearCells',
			id : id,
			pass: pass,
			coords : coordsArr
		});
	};

	const getCell = coords => {
		return gameGrid[coords[0]][coords[1]];
	}

	/* Disable user game actions when viewing a past turn, or someone else's
	game */
	const inPlayState = () => {
		return pass && !gameOver && currentTurn === latestTurn;
	}

	const GameCell = function(coords) {
		/* Get surrounding co-ordinates that aren't cleared or flagged. */
		const surroundingUnknownCoords = () => {
			const ret = [];
			for (let i of [-1, 0, 1])
				for (let j of [-1, 0, 1]) {
					if(i === 0 && j === 0)
						continue;

					let x = coords[0] + i, y = coords[1] + j;

					if(x < 0 || y < 0 || x > dims[0] - 1 || y > dims[1] - 1)
						continue;

					if(gameGrid[x][y].state !== cellState.UNKNOWN)
						continue;

					ret.push([x, y]);
				}
			return ret;
		};

		/* TODO: figure out a nice way to stop the flashing when the cursor
		moves between two cells. Probably use border-collapse on the table, then
		some other CSS to retain the white edges on cells. Or just use fancy
		fading. */
		const hoverSurrounding = hoverOn => {
			for(const c of surroundingUnknownCoords()){
				getCell(c).$elm.toggleClass("cellHover", hoverOn);
			}
		}

		const clearSurrounding = () => {
			const surrCoords = surroundingUnknownCoords();
			if(surrCoords.length > 0)
				clearCells(surrCoords);

			hoverSurrounding(false);
		}

		const getDebug = () => {
			return debugInfo[currentTurn].cellInfo[coords.toString()];
		}

		this.$elm = $("<td>")
			.addClass("cell laminate");

		/* Change state of one cell; perform internal data & GUI changes */
		this.changeState = (newStateName, surrCount) => {
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
						this.$elm.removeClass('cellHover');
						clearCells([coords]);
					},
					contextmenu : () => { this.changeState('flagged'); },
					mouseover : () => { this.$elm.addClass('cellHover'); },
					mouseout : () => { this.$elm.removeClass('cellHover'); }
				},
				cleared : {
					cellState : surrCount,
					class : 'cellCleared',
					text : surrCount > 0 ? surrCount : undefined,
					click : surrCount > 0 ? clearSurrounding : undefined,
					mouseover : surrCount > 0 ?
						() => { hoverSurrounding(true); } : undefined,
					mouseout : surrCount > 0 ?
						() => { hoverSurrounding(false); } : undefined
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

			for(const s in states)
				if(s !== newStateName && states[s].class)
					this.$elm.removeClass(states[s].class);

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
						if(inPlayState())
							newState[mouseAction]();
					});
				}
			}

			if(debug) {
				this.$elm.on('click', () => {
					displayDebug($("#debugAreaCell"), getDebug);
				});
			}

			/* TODO: this is meant to highlight surrounding cells right after
			clicking an unknown cell. Doesn't work (:hover is false); don't know
			why. */
			// if(this.$elm.is(":hover"))
			// 	this.$elm.mouseover();
		};

		this.changeState('unknown');
	};

	if(dims.length !== 2)
		throw new Error("Only 2d games supported!");

	serverWatcher.addEventListener('message', (resp) => {
		const data = JSON.parse(resp.data);
		const turnNumber = data.turn;

		/* Add turn new data from server to list & GUI */
		gameTurns[turnNumber] = data.newCellData;
		$("#turnList").append($("<li>")
			.click(() => {
				if(currentTurn !== turnNumber)
					displayTurn(turnNumber);
			})
			.text("Turn")
			.attr("value", turnNumber)
		);

		/* Wait for initial latestTurn value from server before attempting to
		update it */
		if(latestTurn !== undefined)
			latestTurn = Math.max(latestTurn, turnNumber);

		displayTurn(turnNumber);

		if(data.gameOver) {
			gameOver = true;
			showMsg(data.win ? "Win!!!1" : "Lose :(((");
		}
	});

	debug && serverWatcher.addEventListener('debug', (resp) => {
		const data = JSON.parse(resp.data);
		const turnNumber = data.turn;
		/* How the client indicates a cell is flagged (v. specific to python
		client). */
		const flaggedIndicator = info => info._state == "State.MINE";

		debugInfo[turnNumber] = data.debug;

		toClearCoords[turnNumber] = data.toClear;

		flaggedCoords[turnNumber] = [];
		if(data.debug && data.debug.cellInfo) {
			$.each(data.debug.cellInfo, (key, cellInfo) => {
				if(flaggedIndicator(cellInfo))
					flaggedCoords[turnNumber].push(cellInfo.coords);
			});
		}
	});

	let $gameTable = $("<table>");

	for(let i = 0; i < dims[0]; i++) {
		gameGrid[i] = [];
		let $row = $("<tr>");
		$gameTable.append($row);

		for(let j = 0; j < dims[1]; j++) {
			gameGrid[i][j] = new GameCell([i, j]);
			$row.append(gameGrid[i][j].$elm);
		}
	}

	$gameArea.append($("<ol>").attr("id", "turnList").addClass("laminate"));
	$gameArea.append(
		$("<div>").attr("id", "debugArea").append(
			$("<div>").attr("id", "debugAreaTurn"),
			$("<div>").attr("id", "debugAreaCell")
		)
	);

	this.close = () => {
		$gameArea.empty();
		$("#gameInfo").hide();
		serverWatcher.close();
	}
}
