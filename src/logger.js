
var exports = module.exports = {};
var logger = require("./logger.js");

const winston = require("winston");
const toYAML = require("winston-console-formatter");

function createLogger() {
    const logger = new winston.Logger({
        level: "debug" // We recommend using the debug level for development
    });
   logger.add(winston.transports.Console, toYAML.config());
   return logger;
}


exports.log = function(log_text){

    var logger = createLogger();
    logger.debug(log_text == null ? 'null' : log_text);

}