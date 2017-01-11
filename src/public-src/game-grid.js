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
		if(resp.info)
			errMsg += `\nInfo: ${JSON.stringify(resp.info)}`;
		showMsg(errMsg);
		return;
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
				toClear : false
			};
		}

		return this.arr[key];
	}

	set(key, val) {
		this.arr[key] = val;
	}
}

class GameViewer extends React.Component {
	constructor(props) {
		super(props);

		if(props.dims.length !== 2)
			throw new Error("Only 2d games supported");

		// this.serverWatcher = new EventSource(`server/watch?id=${id}&from=0`);
		// this.serverWatcher.addEventListener("message", ({data}) => {
		// 	this.updateTurnInfo(JSON.parse(data));
		// });
		// showDebug && this.serverWatcher.addEventListener("debug", ({data}) => {
		// 	this.updateDebug(JSON.parse(data));
		// });

		// this._surroundingCells = new Map;

		this.state = {
			gameTurns : [],
			hoverInfo : ndArray([], this.props.dims),
			currentTurn : -1,
			gameOver : false,
			toFlag : new Set(),
			toUnflag : new Set(),
			toClear : new Set(),
			statusMsg : undefined
		};

		keymaster("up", this.viewPrevTurn);
		keymaster("down", this.viewNextTurn);

		$.getJSON("sample-turns.json").then(data => {
			_.each(data, t => this.updateTurnInfo(t));
		});

		$.getJSON("sample-status.json").then(({turnNum}) => {
			this.setState({ currentTurn : turnNum });
		});

		this.refreshGameList();
	}

	performTurn() {
		const { id, pass } = this.props;
		const { toFlag : flag, toUnflag : unflag, toClear : clear} = this.state;

		if(!flag.size && !unflag.size && !clear.size)
			return;

		serverAction("turn", { id, pass, clear, flag, unflag });
	}

	updateTurnInfo({
		turnNum,
		clearReq,
		clearActual,
		flagged,
		unflagged,
		gameOver,
		win,
		cellsRem
	}) {
		const newCellInfo = new ndArray(new CellInfoArray, this.props.dims);
		const newTurn = {
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
		for(coords of flagged) {
			newCellInfo.get(...coords).flagged = true;
		}

		for(coords of unflagged) {
			newCellInfo.get(...coords).flagged = false;
		}

		this.setState(({gameTurns}) => {
			gameTurns[turnNum] = newTurn;
			return {gameTurns};
		});
	}

	viewPrevTurn() {
		console.log(this.state.currentTurn);
		if(this.state.currentTurn > 0) {
			this.setState(({ currentTurn }) => ({ currentTurn : currentTurn - 1}));
		}
	}

	viewNextTurn() {
		console.log(this.state.currentTurn);
		if (this.state.currentTurn < this.state.gameTurns.length - 1) {
			this.setState(({ currentTurn }) => ({ currentTurn : currentTurn + 1}));
		}
	}

	async refreshGameList() {
		this.setState({ games : await $.getJSON("server/games") });
	}

	componentWillUnmount() {
		// this.serverWatcher.close();
		keymaster.unbind("up", this.viewPrevTurn);
		keymaster.unbind("down", this.viewNextTurn);
	}

	cellInfo(x, y) {
		return this.state.gameTurns[this.state.currentTurn].cellInfo.get(x, y);
	}

	surroundingCells(x, y) {
		const [dim_x, dim_y] = this.props.dims;
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
			const { cellState, flagged } = this.cellInfo(_x, _y);

			if(cellState === "unknown" && !flagged)
				this.state.toClear.add([_x, _y]);
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

	cellRightClicked(cellInfo) {
		const queueFlag = (_x, _y) => {
			const { cellState, flagged } = this.cellInfo(_x, _y);
			const [addSet, removeSet] = flagged ?
				[this.state.toUnflag, this.state.toFlag] :
				[this.state.toFlag, this.state.toUnflag];

			if(cellState !== "unknown")
				return;

			/* Only add to set if not currently in the other set (i.e. flag then
			unflag == no action) */
			if(!removeSet.delete(this))
				addSet.add(this);
		};

		this.performSelfOrSurrounding(x, y, queueFlag);
	}

	turnListClicked(turnNum) {
		this.setState({ currentTurn: turnNum });
	}

	render() {
		const {
			turns,
			debugInfo,
			gameTurns,
			currentTurn,
			statusMsg,
			games
		} = this.state;

		const turnInfo = gameTurns[currentTurn];

		return (
			<div className="gameArea">
				{turnInfo && <GameGrid
					dims={this.props.dims}
					turnInfo={turnInfo}
					cellEventFn={(x, y) => this.cellEventFn(x, y)}
				/>}
				<TurnList
					currentTurn={currentTurn}
					gameTurns={gameTurns}
					clickFn={this.turnListClicked}
					initialCellsRem={gameTurns[0] && gameTurns[0].cellsRem}
				/>
				<DebugArea {...{ debugInfo }} />
				{games && <GameList games={games} />}
			</div>
			// <br />
			// <StatusInfo msg={statusMsg} />
		);
	}
}
GameViewer = autobind(GameViewer);

class GameGrid extends React.Component {
	render() {
		const [x_r, y_r] = this.props.dims;
		const cellInfo = (x, y) => this.props.turnInfo.cellInfo.get(x, y);

		return (
			<div onContextMenu={e => e.preventDefault()}>
				<table><tbody>{_.range(y_r).map(y =>
					<tr key={y.toString()}>{_.range(x_r).map(x => (
						<GameCell
							key={x.toString()}
							{ ...cellInfo(x, y) }
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
		let className = "cell laminate " + ({
			flagged : 'cellFlagged',
			mine  : 'cellMine',
			unknown : 'cellUnknown',
			cleared  : 'cellCleared',
		}[this.props.cellState] || "");

		if(this.props.hover && this.props.cellState === "unknown")
			className += " cellHover";

		if(this.props.toClear && this.props.cellState === "unknown")
			className += " cellToClear";

		let text;
		if(this.props.cellState === "cleared" && this.props.surrCount > 0)
			text = this.props.surrCount;

		let event_names = [ "onClick", "onContextMenu", ];
		CELL_HOVER && event_names.push("onMouseEnter", "onMouseLeave");

		let events = {};
		for (const e of event_names) {
			events[e] = () => this.props.onEvent(e);
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
			<div className="gameList"><ul>{
				this.props.games.map((game, i) => {
					const props = {
						info: game,
						selected: game === this.props.currentGame,
						onClick: () => this.props.clickFn(i)
					};

					return <GameListEntry key={i} {...props} />;
				})
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

ReactDOM.render(
	<GameViewer dims={[10,10]} id="gigabeef" pass="b33f" />,
	document.getElementById("gameArea")
);
