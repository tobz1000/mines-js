import React from "react";
import ReactDOM from "react-dom";
import keymaster from "keymaster";
import ndArray from "ndarray";
import $ from "jquery";
import _ from "underscore";
import autobind from 'autobind-decorator';

const CELL_HOVER = false;

/* Send a request to the server; optionally perform an action based on the
response. */
const serverAction = async (action, req) => {
	/* TODO - proper 'fail' handler, once the server gives proper HTTP codes */
	const resp = JSON.parse(
		await $.post('server/' + action, JSON.stringify(req))
	);

	if(resp.error) {
		let errMsg = `Server error: ${resp.error}`;
		if(resp.info !== undefined)
			errMsg += `; info: ${resp.info}`;
		throw new Error(errMsg);
	}

	return resp;
};

/*

GameViewer.state =
{
	gameTurns : {
		turnNum : {
			gameOver : Boolean,
			win : Boolean,
			cellsRem : Number,
			cellInfo : ndArray([ {
				state : String,
				surrCount : Number/undefined,
			} ])
		}
	}
}

GameGrid.props = {
	cellInfo : ndArray([ {
		state : String,
		surrCount : Number/undefined,
	} ])
}

GameGrid.state = {
	hoverInfo : ndArray([ Boolean ])
}

*/

/* Implements a get method for ndarray, which lazy-loads a new default cell
state if empty */
class CellInfoArray {
	constructor() {
		this.arr = [];
	}

	get(key) {
		if(!(key in this.arr)) {
			this.arr[key] = {
				cellState : "unknown",
				surrCount : undefined,
				flagged : false,
				toClear : false,
				toFlag : false,
				toUnflag : false
			};
		}

		return this.arr[key];
	}

	set(key, val) {
		this.arr[key] = val;
	}
}

class GameViewer extends React.Component {
	constructor() {
		super();

		this.state = {
			gameId : undefined,
			games : []
		};

		this.refreshGameList();
	}

	async refreshGameList() {
		this.setState({ games : await serverAction("games") });
	}

	selectGame(id) {
		this.setState({ gameId : id });
	}

	async newGame(mines, dims, pass) {
		const resp = await serverAction("new", {mines, dims, pass});

		this.refreshGameList();
		this.selectGame(resp.id);
	}

	render() {
		const { gameId, games } = this.state;

		return (
			<div className="gameArea">
				{gameId && <ClientGame key={gameId} id={gameId} />}
				<div>
					{games && <GameList
						games={games}
						clickFn={this.selectGame}
						currentId={gameId}
					/>}
					<button onClick={this.refreshGameList}>Refresh list</button>
					<br />
					<NewGameDialogue
						submitFn={this.newGame}
						defaults={{ mines : 10, dim0 : 10, dim1 : 10}}
					/>
				</div>
			{/*<StatusInfo msg={statusMsg} />*/}
			</div>
		);
	}
}
GameViewer = autobind(GameViewer);

class ClientGame extends React.Component {
	constructor(props) {
		super(props);

		this.state = {
			gameTurns : [],
			currentTurn : -1,
			gameOver : false,
			toFlag : new Set(),
			toUnflag : new Set(),
			statusMsg : undefined
		};

		this.toClear = new Set();

		keymaster("up", this.viewPrevTurn);
		keymaster("down", this.viewNextTurn);

		this.serverWatcher = new EventSource(
			`server/watch?id=${props.id}&from=0`
		);

		serverAction("status", { id : props.id }).then(({turnNum}) => {
			this.setState({ currentTurn : turnNum });
		});

		this.serverWatcher.addEventListener("message", ({data}) => {
			this.updateTurnInfo(JSON.parse(data));
		});

		if(props.debug) {
			this.serverWatcher.addEventListener("debug", ({data}) => {
				this.updateDebug(JSON.parse(data));
			});
		}
	}

	cellInfo(x, y) {
		return this.state.gameTurns[this.state.currentTurn].cellInfo.get(x, y);
	}

	get dims() {
		return this.state.gameTurns[this.state.currentTurn].dims;
	}

	surroundingCells(x, y) {
		const [dim_x, dim_y] = this.dims;
		const surr = [];

		for (let i of [-1, 0, 1]) {
			for (let j of [-1, 0, 1]) {
				if(i === 0 && j === 0)
					continue;

				const off_x = x + i, off_y = y + j;

				if(off_x >= 0 && off_y >= 0 && off_x < dim_y & off_y < dim_x)
					surr.push([off_x, off_y]);
			}
		}

		return surr;
	}

	cellEventFn (x, y) {
		/* TODO: Hover state can get stuck when re-viewing an old turn (becomes
		apparent when moving back to current turn). */
		if(!this.inPlayState())
			return () => {};

		const { currentTurn, gameTurns } = this.state;

		return (ev) => ({
			"onClick" : this.cellClicked,
			"onMouseEnter" : this.cellHoveredOn,
			"onMouseLeave" : this.cellHoveredOff,
			"onContextMenu" : this.cellRightClicked
		}[ev](x, y));
	}

	performSelfOrSurrounding(x, y, fn) {
		if(this.cellInfo(x, y).cellState === "cleared") {
			for(let [_x, _y] of this.surroundingCells(x, y)) {
				fn(_x, _y);
			}
		}
		else
			fn(x, y);
	}

	cellClicked(x, y) {
		const queueClear = (_x, _y) => {
			const cell = this.cellInfo(_x, _y);

			if(cell.cellState === "unknown" && !cell.toFlag && !cell.flagged)
				this.toClear.add([_x, _y]);
		};

		this.performSelfOrSurrounding(x, y, queueClear);
		this.performTurn();
	}

	cellHovered(x, y, hoverOn) {
		this.performSelfOrSurrounding(x, y, (_x, _y) => {
			this.setState(state =>{
				const { gameTurns, currentTurn } = state;
				gameTurns[currentTurn].cellInfo.get(_x, _y).hover = hoverOn;
				return { gameTurns };
			})
		});
	}

	cellHoveredOn(x, y) {
		this.cellHovered(x, y, true);
	}

	cellHoveredOff(x, y) {
		this.cellHovered(x, y, false);
	}

	cellRightClicked(x, y) {
		const queueFlag = (_x, _y) => {
			const cell = this.cellInfo(_x, _y);
			const [addSet, removeSet] = cell.flagged ?
				[this.state.toUnflag, this.state.toFlag] :
				[this.state.toFlag, this.state.toUnflag];

			if(cell.cellState !== "unknown")
				return;

			/* Only add to set if not currently in the other set (i.e. flag then
			unflag == no action) */
			if(!removeSet.delete([_x, _y]))
				addSet.add([_x, _y]);

			/* Show flags/unflags before server request. */
			this.setState(prevState => {
				cell.toFlag = !cell.flagged;
				cell.toUnflag = cell.flagged;

				return prevState;
			});
		};

		this.performSelfOrSurrounding(x, y, queueFlag);
	}

	async performTurn() {
		const { id, pass } = this.props;

		const { toFlag : flag, toUnflag : unflag } = this.state;
		const clear = this.toClear;

		if(!flag.size && !unflag.size && !clear.size)
			return;

		const params = { id, pass, clear, flag, unflag, client : "human" };

		const resp = serverAction("turn", params);

		/* Always clear the toClear queue, whether serverAction succeeds or not;
		 * since the user has no visual indicator of a still-queued clear. */
		this.toClear = new Set();

		const turnNum = (await resp).turnNum;

		/* On successful response, flush queued flags. */
		this.setState({
			toFlag : new Set(),
			toUnflag : new Set(),
			currentTurn : turnNum
		});
	}

	updateTurnInfo({
		dims,
		turnNum,
		clearReq,
		clearActual,
		flagged,
		unflagged,
		gameOver,
		win,
		cellsRem
	}) {
		const newCellInfo = new ndArray(new CellInfoArray, dims);
		const newTurn = {
			dims,
			gameOver,
			win,
			cellsRem,
			clearActual,
			clearReq,
			cellInfo : newCellInfo,
		};

		if(turnNum > 0) {
			const prevTurn = this.state.gameTurns[turnNum - 1];

			if(!prevTurn)
				throw Error(`Missing turn number ${turnNum - 1}`);

			const prevCellInfo = prevTurn.cellInfo;

			/* Copy cell info to new turn as an array of new objects */
			for(const i in prevCellInfo.data.arr)
				Object.assign(newCellInfo.data.get(i), prevCellInfo.data.get(i));

			/* Copy the requested clears for this turn to last turn's data. */
			for(const coords of clearReq)
				prevCellInfo.get(...coords).toClear = true;
		}

		/* Update w/ new information for this turn */
		for(const {coords, surrounding, state} of clearActual) {
			Object.assign(newCellInfo.get(...coords), {
				cellState : state,
				surrCount : surrounding
			});
		}

		/* Update flagged/unflagged info */
		for(const coords of flagged) {
			console.log(coords);
			newCellInfo.get(...coords).flagged = true;
			console.log(newCellInfo.get(...coords));
		}

		for(const coords of unflagged) {
			newCellInfo.get(...coords).flagged = false;
		}

		this.setState(({gameTurns}) => {
			gameTurns[turnNum] = newTurn;
			return {gameTurns};
		});
	}

	viewPrevTurn() {
		if(this.state.currentTurn > 0) {
			this.setState(({currentTurn}) => ({ currentTurn : currentTurn - 1}));
		}
	}

	viewNextTurn() {
		if (this.state.currentTurn < this.state.gameTurns.length - 1) {
			this.setState(({currentTurn}) => ({ currentTurn : currentTurn + 1}));
		}
	}

	inPlayState() {
		return (
			!this.state.gameOver &&
			this.state.currentTurn === this.state.gameTurns.length - 1
		);
	}

	componentWillUnmount() {
		this.serverWatcher.close();

		/* TODO: seems to be race condition whereby binding for a new ClientGame
		occurs before unbinding from the previous, causing unbinding to fail (?) */
		keymaster.unbind("down", this.viewNextTurn);
		keymaster.unbind("up", this.viewPrevTurn);
	}

	render() {
		const {
			turns,
			debugInfo,
			gameTurns,
			currentTurn
		} = this.state;

		const turnInfo = gameTurns[currentTurn];

		return (
			<div className="gameArea">
				{turnInfo && <GameGrid
					inPlayState={this.inPlayState()}
					turnInfo={turnInfo}
					cellEventFn={(x, y) => this.cellEventFn(x, y)}
				/>}
				<TurnList
					currentTurn={currentTurn}
					gameTurns={gameTurns}
					clickFn={turnNum => this.setState({ currentTurn: turnNum })}
					initialCellsRem={gameTurns[0] && gameTurns[0].cellsRem}
				/>
				<DebugArea {...{ debugInfo }} />
			</div>
			// <br />
			// <StatusInfo msg={statusMsg} />
		);
	}
}
ClientGame = autobind(ClientGame);

class GameGrid extends React.Component {
	render() {
		const [x_r, y_r] = this.props.turnInfo.dims;
		const cellInfo = (x, y) => this.props.turnInfo.cellInfo.get(x, y);

		return (
			<div onContextMenu={e => e.preventDefault()}>
				<table><tbody>{_.range(y_r).map(y =>
					<tr key={y.toString()}>{_.range(x_r).map(x => (
						<GameCell
							key={x.toString()}
							{ ...cellInfo(x, y) }
							inPlayState={this.props.inPlayState}
							onEvent={this.props.cellEventFn(x, y)}
						/>
					))}</tr>
				)}</tbody></table>
			</div>
		);
	}
}

class GameCell extends React.Component {
	render() {
		const {
			cellState,
			surrCount,
			flagged,
			toClear,
			toFlag,
			toUnflag,
			hover,
			onEvent
		} = this.props;

		let className = "cell laminate " + ({
			mine  : 'cellMine',
			unknown : 'cellUnknown',
			cleared  : 'cellCleared',
		}[cellState] || "");

		if(cellState === "unknown") {
			if(
				(flagged && !toUnflag) ||
				(!flagged && toFlag && this.props.inPlayState)
			)
				className += " cellFlagged";
			else if(hover && this.props.inPlayState)
				className += " cellHover";
			else if(toClear)
				className += " cellToClear";
		}

		let text;
		if(cellState === "cleared" && surrCount > 0)
			text = surrCount;

		let event_names = [ "onClick", "onContextMenu", ];
		CELL_HOVER && event_names.push("onMouseEnter", "onMouseLeave");

		let events = {};
		for (const e of event_names) {
			events[e] = () => onEvent(e);
		}

		return <td {...{ className }} {...events}>{text}</td>;
	}
}

class TurnList extends React.Component {
	render() {
		return (
			<ol className="turnList laminate">{
				this.props.gameTurns.map((turn, i) => {
					const props = {
						turnNum: i,
						info: turn,
						selected: i === this.props.currentTurn,
						initialCellsRem: this.props.initialCellsRem,
						onClick: () => this.props.clickFn(i)
					};

					return <TurnListEntry key={i} {...props} />;
				})
			}</ol>
		);
	}
}

class TurnListEntry extends React.Component {
	render() {
		const {clearActual, clearReq, gameOver, win, cellsRem } = this.props.info;

		const infoItems = [
			{ type: "clearReq", text: clearReq.length },
			{ type: "clearActual", text: clearActual.length }
		];

		if(gameOver)
			infoItems.push({ type: win ? "win" : "lose" });
		else if(this.props.initialCellsRem !== undefined) {
			const percComp = 100 * (1 - cellsRem / this.props.initialCellsRem);
			infoItems.push({ type: "percComplete", text: `${percComp.toFixed()}%`})
		}

		return (
			<li
				value={this.props.turnNum}
				className={this.props.selected ? "listSelected" : undefined}
				onClick={this.props.onClick}
			>{
				infoItems.map((props, i) => <ListItemProp key={i} {...props} />)
			}</li>
		);
	}
}

class DebugArea extends React.Component {
	render() {
		return (
			<div className="debugArea">
				<div className="debugAreaTurn" />
				<div className="debugAreaCell" />
			</div>
		);
	}
}

class GameList extends React.Component {
	render() {
		return (
			<div className="gameList laminate"><ul>{
				this.props.games.map((game, i) =>
					<GameListEntry
						key={i}
						info={game}
						selected={game.id === this.props.currentId}
						onClick={() => this.props.clickFn(game.id)}
					/>
				)
			}</ul></div>
		)
	}
}

class GameListEntry extends React.Component {
	render() {
		const { mines, clients, dims, id } = this.props.info;

		const infoItems = [
			{ type: "id", text: id },
			{ type: "dims", text: `${dims[0]}x${dims[1]}` },
			{ type: "mines", text: mines },
		];

		return (
			<li
				className={this.props.selected ? "listSelected" : undefined}
				onClick={this.props.onClick}
			>{
				infoItems.map((props, i) => <ListItemProp key={i} {...props} />)
			}</li>
		);
	}
}

class ListItemProp extends React.Component {
	render() {
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
		}[this.props.type];

		const minWidth = (minChars || 0) + (icon ? 2 : 0);
		return (
			<span style={{ minWidth: `${minWidth}ch` }}>{[
				icon && <i key="i" className={`fa ${icon}`} />,
				this.props.text
			]}</span>
		)
	}
}

class NewGameDialogue extends React.Component {
	constructor(props) {
		super(props);

		this.state = Object.assign({}, this.props.defaults);
		this.submitFn = () => {
			const { mines, dim0, dim1 } = this.state;
			this.props.submitFn(mines, [dim0, dim1], undefined);
		};
	}

	textEntryFn(param, val) {
		this.setState({ [param] : val });
	}

	render() {
		return (
			<div>
				<NumberEntry
					label="Mines: "
					param="mines"
					def={this.props.defaults.mines}
					entryFn={this.textEntryFn}
				/>
				{' '}
				<NumberEntry
					label="Columns: "
					param="dim0"
					def={this.props.defaults.dim0}
					entryFn={this.textEntryFn}
				/>
				{' '}
				<NumberEntry
					label="Rows: "
					param="dim1"
					def={this.props.defaults.dim1}
					entryFn={this.textEntryFn}
				/>
				{' '}
				<button onClick={this.submitFn}>New Game</button>
			</div>
		)
	}
}
NewGameDialogue = autobind(NewGameDialogue);

class NumberEntry extends React.Component {
	constructor() {
		super();

		this.entryFn = evt => {
			this.props.entryFn(this.props.param, Number(evt.target.value));
		};
	}

	render() {
		const { label, param, def } = this.props;
		const input = (
			<input type="number" min="1" onChange={this.entryFn} value={def} />
		);

		return label && <label>{label}{input}</label> || input;
	}
}
NumberEntry = autobind(NumberEntry);

ReactDOM.render(
	<GameViewer />,
	document.getElementById("gameArea")
);
