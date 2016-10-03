"use strict";

/* Example code to hook into Python domain. */

const PythonShell = require("python-shell");

const pythonRoot = __dirname + "/../../py";

const games = [
	{ dims : [10,10], mines : 3, server : "JSONServerWrapper", repeats : 10 },
];

const ps = new PythonShell(
	"game_init.py",
	{
		pythonPath : pythonRoot + "/venv/bin/python3.4",
		scriptPath : pythonRoot + "/src",
		args : JSON.stringify(games)
	},
	(err, res) => err && console.error(err)
);
ps.on("message", (msg) => console.log(msg));