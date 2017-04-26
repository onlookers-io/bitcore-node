'use strict';

var _ = require('lodash');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var chai = require('chai');
var should = chai.should();
var spawn = require('child_process').spawn;
var async = require('async');
var bitcore = require('bitcore-lib');
var Unit = bitcore.Unit;
var Transaction = bitcore.Transaction;
var PrivateKey = bitcore.PrivateKey;
var BitcoinRPC = require('bitcoind-rpc');
var path = require('path');
var fs = require('fs');
var http = require('http');
var crypto = require('crypto');

var bitcoreDataDir = '/tmp/bitcore';
var bitcoinDataDir = '/tmp/bitcoin';

var rpcConfig = {
  protocol: 'http',
  user: 'bitcoin',
  pass: 'local321',
  host: '127.0.0.1',
  port: '58332',
  rejectUnauthorized: false
};

var bitcoin = {
  args: {
    datadir: bitcoinDataDir,
    listen: 0,
    regtest: 1,
    server: 1,
    rpcuser: rpcConfig.user,
    rpcpassword: rpcConfig.pass,
    rpcport: rpcConfig.port,
    zmqpubrawtx: 'tcp://127.0.0.1:38332',
    zmqpubhashblock: 'tcp://127.0.0.1:38332'
  },
  datadir: bitcoinDataDir,
  exec: 'bitcoind', //if this isn't on your PATH, then provide the absolute path, e.g. /usr/local/bin/bitcoind
  process: null
};

var bitcore = {
  configFile: {
    file: bitcoreDataDir + '/bitcore-node.json',
    conf: {
      network: 'regtest',
      port: 53001,
      datadir: bitcoreDataDir,
      services: [
        'bitcoind',
        'db',
        'transaction',
        'timestamp',
        'address',
        'mempool',
        'wallet-api',
        'web'
      ],
      servicesConfig: {
        bitcoind: {
          connect: [
            {
              rpcconnect: rpcConfig.host,
              rpcport: rpcConfig.port,
              rpcuser: rpcConfig.user,
              rpcpassword: rpcConfig.pass,
              zmqpubrawtx: bitcoin.args.zmqpubrawtx
            }
          ]
        }
      }
    }
  },
  httpOpts: {
    protocol: 'http:',
    hostname: 'localhost',
    port: 53001,
  },
  opts: { cwd: bitcoreDataDir },
  datadir: bitcoreDataDir,
  exec: path.resolve(__dirname, '../bin/bitcore-node'),
  args: ['start'],
  process: null
};

var rpc = new BitcoinRPC(rpcConfig);
var walletPassphrase = 'test';
var startingSatoshis = 0;

var numberOfStartingTxs = 50;

var walletPrivKeys = [];
var initialTxs = [];
var fee = 100000;
var walletId = crypto.createHash('sha256').update('test').digest('hex');

describe('Wallet Operations', function() {

  this.timeout(60000);

  after(function(done) {
    bitcore.process.kill();
    bitcoin.process.kill();
    setTimeout(done, 2000);
  });

  before(function(done) {
    async.series([
      startBitcoind,
      waitForBitcoinReady,
      unlockWallet,
      setupInitialTxs, //generate a set of transactions to get us a predictable history
      startBitcoreNode,
      waitForBitcoreNode
    ], done);
  });

  it('should register wallet', function(done) {

    var httpOpts = Object.assign({
      path: '/wallet-api/wallets/' + walletId,
      method: 'POST'
    }, bitcore.httpOpts);

    queryBitcoreNode(httpOpts, function(err, res) {
      if (err) {
        return done(err);
      }
      res.should.deep.equal(JSON.stringify({
        walletId: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
      }));
      done();
    });
  });

  it('should upload a wallet', function(done) {
    var addresses = JSON.stringify(walletPrivKeys.map(function(privKey) {
      return privKey.toAddress().toString();
    }));
    var httpOpts = Object.assign({
      path: '/wallet-api/wallets/' + walletId + '/addresses',
      method: 'POST',
      body: addresses,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': addresses.length
      }
    }, bitcore.httpOpts);
    async.waterfall([ queryBitcoreNode.bind(this, httpOpts) ], function(err, res) {
      if (err) {
        return done(err);
      }
      var job = JSON.parse(res);

      Object.keys(job).should.deep.equal(['jobId']);

      var httpOpts = Object.assign({
        path: '/wallet-api/jobs/' + job.jobId,
        method: 'GET'
      }, bitcore.httpOpts);

      async.retry({ times: 10, interval: 1000 }, function(next) {
        queryBitcoreNode(httpOpts, function(err, res) {
          if (err) {
            return next(err);
          }
          var result = JSON.parse(res);
          if (result.status === 'complete') {
            return next();
          }
          next(res);
        });

      }, function(err) {
        if(err) {
          return done(err);
        }
        done();
      });
    });
  });

  it('should get a list of transactions', function(done) {
    var httpOpts = Object.assign({
      path: '/wallet-api/wallets/' + walletId + '/transactions',
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    }, bitcore.httpOpts);
    queryBitcoreNode(httpOpts, function(err, res) {
      if(err) {
        return done(err);
      }
      var results = res.split('\n').slice(0, -1);
      results.length.should.equal(numberOfStartingTxs);
      for(var i = 0; i < results.length; i++) {
        var result = results[i];
        var tx = new Transaction(JSON.parse(result));
        tx.uncheckedSerialize().should.equal(initialTxs[i].serialize());
      }
      done();
    });
  });
});

function writeConfigFile(fileStr, obj) {
  fs.writeFileSync(fileStr, JSON.stringify(obj));
}

function toArgs(opts) {
  return Object.keys(opts).map(function(key) {
    return '-' + key + '=' + opts[key];
  });
}

function waitForService(task, next) {
  var retryOpts = { times: 20, interval: 1000 };
  async.retry(retryOpts, task, next);
}

function queryBitcoreNode(httpOpts, next) {
  var error;
  var request = http.request(httpOpts, function(res) {

    if (res.statusCode !== 200 && res.statusCode !== 201) {
      if (error) {
        return;
      }
      return next(res.statusCode);
    }

    var resError;
    var resData = '';

    res.on('error', function(e) {
      resError = e;
    });

    res.on('data', function(data) {
      resData += data;
    });

    res.on('end', function() {
      if (error) {
        return;
      }
      if (httpOpts.errorFilter) {
        return next(httpOpts.errorFilter(resError, resData));
      }
      next(resError, resData);
    });

  });

  request.on('error', function(e) {
    error = e
    next(error);
  });

  request.write(httpOpts.body || '');
  request.end();
}

function waitForBitcoreNode(next) {
  bitcore.process.stdout.on('data', function(data) {
    console.log(data.toString());
  });
  bitcore.process.stderr.on('data', function(data) {
    console.log(data.toString());
  });
  var errorFilter = function(err, res) {
    if (err || (res && !JSON.parse(res).result)) {
      return 'still syncing';
    }
  };

  var httpOpts = Object.assign({
    path: '/wallet-api/issynced',
    errorFilter: errorFilter,
    method: 'GET'
  }, bitcore.httpOpts);

  waitForService(queryBitcoreNode.bind(this, httpOpts), next);
}

function waitForBitcoinReady(next) {
  waitForService(function(next) {
    rpc.generate(101, function(err, res) {
      if (err || (res && res.error)) {
        return next('keep trying');
      }
      next();
    });
  }, function(err) {
    if(err) {
      return next(err);
    }
    next();
  }, next);
}

function initializeAndStartService(opts, next) {
  rimraf(opts.datadir, function(err) {
    if(err) {
      return next(err);
    }
    mkdirp(opts.datadir, function(err) {
      if(err) {
        return next(err);
      }
      if (opts.configFile) {
        writeConfigFile(opts.configFile.file, opts.configFile.conf);
      }
      var args = _.isArray(opts.args) ? opts.args : toArgs(opts.args);
      opts.process = spawn(opts.exec, args, opts.opts);
      next();
    });
  });
}

function startBitcoreNode(next) {
  initializeAndStartService(bitcore, next);
}

function startBitcoind(next) {
  initializeAndStartService(bitcoin, next);
}

function unlockWallet(next) {
  rpc.walletPassPhrase(walletPassphrase, 3000, function(err, res) {
    if(err && err.code !== -15) {
      return next(err);
    }
    next();
  });
}

function getPrivateKeyWithABalance(next) {
  rpc.listUnspent(function(err, res) {
    if(err) {
      return next(err);
    }

    var utxo;
    for(var i = 0; i < res.result.length; i++) {
      if (res.result[i].amount > 1) {
        utxo = res.result[i];
        break;
      }
    }
    if (!utxo) {
      return next(new Error('no utxos available'));
    }
    rpc.dumpPrivKey(utxo.address, function(err, res) {
      if(err) {
        return next(err);
      }
      var privKey = res.result;
      next(null, privKey, utxo);
    });
  });
}

function generateSpendingTx(privKey, utxo) {

  var toPrivKey = new PrivateKey('testnet'); //external addresses
  var changePrivKey = new PrivateKey('testnet'); //our wallet keys
  var utxoSatoshis = Unit.fromBTC(utxo.amount).satoshis;
  var satsToPrivKey = Math.round(utxoSatoshis / 2);
  var tx = new Transaction();

  tx.from(utxo);
  tx.to(toPrivKey.toAddress().toString(), satsToPrivKey);
  tx.fee(fee);
  tx.change(changePrivKey.toAddress().toString());
  tx.sign(privKey);

  walletPrivKeys.push(changePrivKey);
  return tx;
}

function setupInitialTx(index, next) {
  getPrivateKeyWithABalance(function(err, privKey, utxo) {
    if(err) {
      return next(err);
    }
    var tx = generateSpendingTx(privKey, utxo);
    sendTx(tx, function(err, tx) {
      if(err) {
        return next(err);
      }
      initialTxs.push(tx);
      next();
    });
  });
};

function setupInitialTxs(next) {
  async.timesSeries(numberOfStartingTxs, setupInitialTx, next);
}

function sendTx(tx, next) {
  rpc.sendRawTransaction(tx.serialize(), function(err, res) {
    if(err) {
      return next(err);
    }
    rpc.generate(1, function(err) {
      if(err) {
        return next(err);
      }
      next(null, tx);
    });
  });
}
