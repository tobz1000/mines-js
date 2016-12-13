import React from "react";
import ReactDOM from "react-dom";
import ndArray from "ndarray";
import $ from "jquery";

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
class CellInfoArray extends Array {
	get(key) {
		if(!(key in this)) {
			this[key] = {
				cellState : "unknown",
				surrCount : undefined,
				flagged : false
			};
		}

	set(key, val) {
		this[key] = val;
	}

		return this[key];
	}
}

class ClientGame extends React.Component {
	constructor(props) {
		if(props.dims.length !== 2)
			throw new Error("Only 2d games supported");

		this.serverWatcher = new EventSource(`server/watch?id=${id}&from=0`);
		this.serverWatcher.addEventListener("message", ({data}) => {
			this.updateTurnInfo(JSON.parse(data));
		});
		showDebug && this.serverWatcher.addEventListener("debug", ({data}) => {
			this.updateDebug(JSON.parse(data));
		});

		/* TODO: which of these shouldn't be in "state" (if any)? */
		this.state = {
			gameTurns : {}
			// hoverInfo : ndArray([], this.props.dims),
			currentTurn : -1,
			latestTurn : undefined,
			gameOver : false,
			toFlag : new Set(),
			toUnflag : new Set(),
			statusMsg : undefined
		};

		/* Retrieve turn number from /status, so we know when the final SSE
		 * message has been received */
		serverAction("status", { id }).then(({turnNum}) => {
			this.setState({ latestTurn : turnNum });
			this.displayTurn(turnNum);
		}).catch(showMsg);
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
			for(const i in prevCellInfo.data)
				Object.assign(newCellInfo.data.get(i), prevCellInfo.data[i]);

			/* Copy the requested clears for this turn to last turn's data. */
			for(const coords of clearReq)
				prevCellInfo.get(...coords).toClear = true;
		}

		/* Update w/ new information for this turn */
		for({coords, surrounding, state} of clearActual) {
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
		})

		/* Wait for initial latestTurn value from server before attempting to
		update it */
		if(this.state.latestTurn !== undefined) {
			this.setState(prevState => (
				{ latestTurn : Math.max(prevState.latestTurn, turnNum) }
			));
		}
	}

	componentWillUnmount() {
		this.serverWatcher.close();
	}

	onGameGridEvent(evt) {

	}

	render() {
		const { turns, debugInfo, gameTurns, currentTurn, statusMsg } = this.state;

		return (
			<GameGrid
				dims={this.props.dims}
				turnInfo={gameTurns[currentTurn]}
				onEvent=onGameGridEvent
			/>
			// <TurnList {...{ currentTurn, turns }} />
			// <DebugArea {...{ debugInfo }} />
			// <br />
			// <StatusInfo msg={statusMsg} />
		);
	}
}

class GameGrid extends React.Component {
	cellEventFn (x, y) {
		return (ev) => ({
			"onClick" : this.cellClicked,
			"onMouseEnter" : this.cellHoveredOn,
			"onMouseLeave" : this.cellHoveredOff,
			"onContextMenu" : this.cellRightClicked
		}[ev](this.props.turnInfo.get(x, y)));
	}

	cellClicked(cellInfo) {
		if(cellInfo.cellState === "unknown")
			this.props.onEvent("clear");

		if(cellInfo.cellState === "cleared") {
			for c of surroundingCells.get(cellInfo) {
				if c.cellState === "unknown"{}
			}
		}
	}

	cellHoveredOn(cellInfo) {}

	cellHoveredOff(cellInfo) {}

	cellRightClicked(cellInfo) {}

	render() {
		const [x_r, y_r] = this.props.dims;
		return (
			<div onContextMenu={e => e.preventDefault()}>
				<table>{_.range(y_r).map(y =>
					<tr key={y.toString()}>{_.range(x_r).map(x => {
						<GameCell
							key={x.toString()}
							cellState={this.props.turnInfo.get(x, y).cellState}
							surrCount={this.props.turnInfo.get(x, y).surrCount}
							onEvent={cellEventFn(x, y)}
						/>
					})}</tr>
				)}</table>
			</div>
		);
	}
}

class GameCell extends React.Component {
	render() {
		const className = "cell laminate " + ({
				flagged : 'cellFlagged',
				mine  : 'cellMine',
				unknown : 'cellUnknown',
				cleared  : 'cellCleared',
			}
		}[this.props.cellState] || "");

		if(this.props.hover && this.props.cellState === "unknown")
			className += " cellHover";

		const text = undefined;

		if(this.props.cellState === "cleared" && this.props.surrCount > 0)
			text = this.props.surrCount;

		const evts = {};

		for (e of [ "onClick", "onContextMenu", "onMouseEnter", "onMouseLeave" ]) {
			evts[e] = () => this.props.onEvent(e);
		}

		return <td {{ className } { ...evts }}>{text}</td>;
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
