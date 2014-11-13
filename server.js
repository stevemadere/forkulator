var express         = require('express');
var morgan          = require('morgan');
var cookieParser    = require('cookie-parser');
var bodyParser      = require('body-parser');
var connect         = require('connect');
var connectTimeout  = require('connect-timeout');
var log             = require('simplog');
var child_process   = require('child_process');
var path            = require('path');
var fs              = require('fs');
var Promise         = require('bluebird');

config = {
  outputDirectory: process.env.FORK_OUTPUT
    || process.env.TEMP
    || process.env.TMPDIR
}

var app = express();

app.use(connect());
app.use(morgan('combined'));
app.use(cookieParser());
// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }))
// parse application/json
app.use(bodyParser.json())
// parse application/vnd.api+json as json
app.use(bodyParser.json({ type: 'application/vnd.api+json' }))

var requestCounter = 0;
/* this just needs to generate something like a unique file name */
function createTempFileName(prefix){
  return prefix + process.pid + requestCounter++;
}

var counterAgain = 0;
var countOfCurrentlyExecutingRequests = 0;
function executeThrottled(req, res){
  if (countOfCurrentlyExecutingRequests < 5){
    countOfCurrentlyExecutingRequests++;
    handleRequest(req, res).then(countOfCurrentlyExecutingRequests--);  
  } else {
   setTimeout(0, function() { executeThrottled(req, res); });
  }
}
// respond
app.use(function(req, res, next){
  executeThrottled(req,res);
});
function handleRequest(req, res){
  var err = null;
  function captureError(e) { err = e; }
  var response = null;
  var thisRequest = counterAgain++;
  var pathToHandler = path.join(__dirname, "commands", req.path);
  var outfilePath = path.join(config.outputDirectory, createTempFileName('testsdout'));
  var errfilePath = path.join(config.outputDirectory, createTempFileName('testsderr'));
  var outfileStream = fs.createWriteStream(outfilePath);
  var errfileStream = fs.createWriteStream(errfilePath);
  var handler;
  function removeTempFiles(){
    fs.unlink(outfilePath, function(e) {if (e){ log.warn(e);}});
    fs.unlink(errfilePath, function(e) {if (e){ log.warn(e);}});
  };
  var promiseIllFinish = new Promise(function(resolve, reject){
    res.on('finish', function(){ removeTempFiles(); resolve(); });
  })
  outfileStreamOpened = new Promise(function(resolve, reject){
    outfileStream.on('open', resolve);
  });
  errfileStreamOpened = new Promise(function(resolve, reject){
    errfileStream.on('open', resolve);
  });
  Promise.all([errfileStreamOpened, outfileStreamOpened]).then(function(){
    handler = child_process.spawn( pathToHandler, [],
      {stdio: ['pipe', outfileStream, errfileStream]});
    handler.on('error', captureError);
    handler.stdin.on('error', function(e){
      res.type('application/json').status(500).send({message: e});
    });
    handler.on('close', function(exitCode, signal){
      if (exitCode !== 0 || err || signal){
        res.status(500);
        res.write('{"message":"');
        if (err) { 
          res.write(err + "");
        }
        if (signal){
          res.write("killed by signal: " + signal);
        }
        errStream = fs.createReadStream(errfilePath);
        errStream.on('end', function(){ res.end('"}'); });
        errStream.on('error', function(e){ res.write("there was trouble reading the error output from the process: " + e); });
        errStream.pipe(res, {end:false});
      } else {
        res.type('application/json'); // we'll be doing our best to return JSON
        fs.createReadStream(outfilePath).pipe(res);
      }
    });
    handler.stdin.end(JSON.stringify({
      url:req.url,
      query:req.query,
      body:req.body,
      headers:req.headers,
      path:req.path
    }));
  }).catch(function(e) { log.error(e); });
  return promiseIllFinish;
}

listenPort = process.env.PORT || 3000;
log.info("starting app " + process.env.APP_NAME);
log.info("listening on " + listenPort);
app.listen(listenPort);
