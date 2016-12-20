import React from "react";
import ReactDOM from "react-dom";
import ndArray from "ndarray";
import $ from "jquery";
import _ from "underscore";

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

ClientGame.state =
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
				flagged : false
			};
		}

		return this.arr[key];
	}

	set(key, val) {
		this.arr[key] = val;
	}
}

class ClientGame extends React.Component {
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

		/* TODO: which mof these shouldn't be in "state" (if any)? */
		this.state = {
			gameTurns : {},
			// hoverInfo : ndArray([], this.props.dims),
			currentTurn : -1,
			gameOver : false,
			toFlag : new Set(),
			toUnflag : new Set(),
			toClear : new Set(),
			statusMsg : undefined
		};

		$.getJSON("sample-turns.json").then(data => {
			_.each(data, t => this.updateTurnInfo(t));
		});

		$.getJSON("sample-status.json").then(({turnNum}) => {
			this.setState({ currentTurn : turnNum });
		});
	}

	performTurn() {
		const { id, pass } = this.props;
		const { toFlag, toUnflag, toClear : clear} = this.state;

		const turnParams = { id, pass };



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
		const newTurn = { gameOver, win, cellsRem, cellInfo : newCellInfo };

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

	componentWillUnmount() {
		this.serverWatcher.close();
	}

	cellInfo(x, y) {
		return this.state.gameTurns[this.state.currentTurn].get(x, y);
	}

	surroundingCells(x, y) {
		const [dim_x, dim_y] = this.props.dims;
		// if(!this._surroundingCells.has(cellInfo)) {
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

		// 	this._surroundingCells.set(cellInfo, surr);
		// }

		// return this._surroundingCells.get(cellInfo);
	}

	cellEventFn(x, y) {
		const { currentTurn, gameTurns } = this.state;

		return (ev) => ({
			"onClick" : this.cellClicked,
			"onMouseEnter" : this.cellHoveredOn,
			"onMouseLeave" : this.cellHoveredOff,
			"onContextMenu" : this.cellRightClicked
		// }[ev](x, y, gameTurns[currentTurn].get(x, y)));
		}[ev](x, y));
	}

	cellClicked(x, y) {
		const { cellState } = cellInfo(x, y);

		if(cellState === "unknown") {}

		if(cellState === "cleared") {
			for(let c of surroundingCells.get(cellInfo)) {
				if(c.cellState === "unknown"){}
			}
		}
	}

	cellHoveredOn(cellInfo) {}

	cellHoveredOff(cellInfo) {}

	cellRightClicked(cellInfo) {}

	render() {
		const {
			turns,
			debugInfo,
			gameTurns,
			currentTurn,
			statusMsg
		} = this.state;

		const turnInfo = gameTurns[currentTurn];

		return (
			<div>
				{turnInfo && <GameGrid
					dims={this.props.dims}
					turnInfo={turnInfo}
					cellEventFn={(x, y) => this.cellEventFn(x, y)}
				/>}
			</div>
				// <TurnList {...{ currentTurn, turns }} />
				// <DebugArea {...{ debugInfo }} />
				// <br />
				// <StatusInfo msg={statusMsg} />
		);
	}
}

class GameGrid extends React.Component {
	render() {
		console.log(this.props);
		const [x_r, y_r] = this.props.dims;
		const cellInfo = {
			cellState : "unknown",
			surrCount : undefined,
			flagged : false
		};
		// const cellInfo = this.props.turnInfo.get(x, y);
		return (
			<div onContextMenu={e => e.preventDefault()}>
				<table><tbody>{_.range(y_r).map(y =>
					<tr key={y.toString()}>{_.range(x_r).map(x => (
						<GameCell
							key={x.toString()}
							{ ...cellInfo }
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

		let text;

		if(this.props.cellState === "cleared" && this.props.surrCount > 0)
			text = this.props.surrCount;

		let evts = {};

		for (const e of [ "onClick", "onContextMenu", "onMouseEnter", "onMouseLeave" ]) {
			evts[e] = () => this.props.onEvent(e);
		}

		return <td {...{ className }} {...evts}>{text}</td>;
	}

	get surroundingCells() {
		const {coords, game} = this.props;
		if(!this._surroundingCells) {
			this._surroundingCells = [];

			for (let i of [-1, 0, 1]) {
				for (let j of [-1, 0, 1]) {
					if(i === 0 && j === 0)
						continue;

					const x = coords[0] + i, y = coords[1] + j;

					if(
						x < 0 ||
						y < 0 ||
						x > game.dims[0] - 1 ||
						y > game.dims[1] - 1
					)
						continue;

					this._surroundingCells.push(game.getCell([x, y]));
				}
			}
		}

		return this._surroundingCells;
	}

	hover(hoverOn) {
		if(this.props.cellState === "unknown")
			this.setState({ hover : hoverOn });
	}

	hoverSurrounding(hoverOn) {
		for(const cell of this.surroundingCells)
			cell.hover(hoverOn);
	}

	clearSurrounding() {
		this.hoverSurrounding(false);

		this.props.game.clearCells(
			this.surroundingCells.filter(c => c.state.stateName === "unknown")
		);
	}

	get debug() {
		const {coords, game:{debugInfo}} = this.props;
		return debugInfo[this.currentTurn].cellInfo[coords.toString()];
	}

	toggleFlag(flagUp) {
		const {toFlag, toUnflag} = this.props.game;
		const [addSet, removeSet, newState] = flagUp ?
			[toFlag, toUnflag, "flagged"] : [toUnflag, toFlag, "unknown"];

		this.setState({ cellState: newState });

		/* Only add to set if not currently in the other set (i.e. flag then
		unflag == no action) */
		if(!removeSet.delete(this))
			addSet.add(this);
	}
}

ReactDOM.render(
	<ClientGame dims={[10,10]} id="gigabeef" pass="b33f" />,
	document.getElementById("gameArea")
);