const ReqError = function(error, info) {
	this.error = error;
	this.info = info;
};

module.exports = {
	ReqError : ReqError
};