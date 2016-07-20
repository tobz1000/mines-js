"use strict";
const express = require('express');
const sse = require('express-eventsource');
const _ = require('underscore');

const ReqError = require("./error").ReqError;

const entities = [
	{ path: "/server", entity: require("./game-server") },
	// { path: "/manager", entity: require("./manager") }
];

const serverInit = () => {
	const app = express();
	const entitiesReady = [];

	app.use(express.static('public'));

	for(let i of entities) {
		const pr = i.entity.init().then(() => {
			app.post(i.path, responsePoster(i.entity));
		});
		entitiesReady.push(pr);
	}

	Promise.all(entitiesReady).then(() => {
		console.log("server ready");
		app.listen(1066);
	});
};

const responsePoster = (entity) => {
	/*	TODO: can't figure out how to process multiple requests at once!
		Seems post requests are queued, and a new one isn't started until the
		response for the last one is end()ed. */
	const reqHandler = async (body, resp) => {
		let responseObj;

		try {
			const req = JSON.parse(body);
			responseObj = await entity.actions[req.action].func(req);
		} catch(e) {
			if(e instanceof SyntaxError)
				responseObj = { error: "malformed JSON request data" };
			else if (e instanceof ReqError) {
				responseObj = e;
				console.log(
					`Problem with client request: ${JSON.stringify(e)}`
				);
			} else {
				console.error(`Unhandled error: ${e.stack}`);
				responseObj = { error: "unknown error" };
			}
		}
		resp.end(JSON.stringify(responseObj));
	}

	return (req, resp) => {
		let body = "";
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			reqHandler(body, resp);
		});
	};
};

serverInit();