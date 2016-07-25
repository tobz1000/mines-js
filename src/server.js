"use strict";
const express = require('express');
const sse = require('express-eventsource');
const _ = require('underscore');

const ReqError = require("./error").ReqError;

const entityPaths = [
	{ path : "server", entity : require("./game-server") }
];

const serverInit = () => {
	const entityTypeWrappers = {
		post : responsePoster,
		sse : sseReplayer
	};

	const app = express();

	app.use("/", express.static("src/public"));

	const entitiesReady = entityPaths.map(async ({path, entity}) => {
		if(entity.init)
			await entity.init();

		_.each(entity.actions, (action, subpath) => {
			const respFn = entityTypeWrappers[action.type](action.handler);

			/* Ignore HTTP verb */
			app.all("/" + path + "/" + subpath, respFn);
		});
	});

	Promise.all(entitiesReady).then(() => {
		console.log("server ready");
		app.listen(1066);
	}).catch(console.error);
};

const responsePoster = (handler) => {
	/*	TODO: can't figure out how to process multiple requests at once!
		Seems post requests are queued, and a new one isn't started until the
		response for the last one is end()ed. */
	const reqHandler = async (post, get, resp) => {
		let responseObj;
		try {
			const params = _.extend({}, post && JSON.parse(post), get);
			responseObj = await handler(params);
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
	};

	return (req, resp) => {
		let body = "";
		req.on('data', chunk => {
			body += chunk;
		});
		req.on('end', () => {
			/* Allow POST-body and/or URL query params */
			reqHandler(body, req.query, resp).catch(console.error);
		});
	};
};

/* Hacky; uses sse's reconnection replay to get all events from a given point in
history. */
const sseReplayer = (handler) => {
	return async (req, resp, next) => {
		try {
			if(!req.get('last-event-id') && req.query.from !== undefined)
				req.headers['last-event-id'] = Number(req.query.from) - 1;

			const sse = await handler(req.query);

			sse.middleware()(req, resp, next);
		} catch(e) {
			console.log(e);
		}
	};
};

serverInit();
