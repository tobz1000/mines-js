"use strict";
$(() => {
	$("#button").click(() => {
		new EventSource(`watch?id=${$("#gameId").val()}&from=0`)
			.addEventListener('message', (resp) => { console.log(resp); });
	});
});