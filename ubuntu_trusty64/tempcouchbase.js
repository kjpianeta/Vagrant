
var globalConfig = require('../utils/config.js');
var generalConfig = globalConfig.config;
var config = generalConfig.couchbaseConfig;
var uuid = require('node-uuid');
var moment = require('moment-timezone');
var couch = require('couchbase');
// var cluster = new couch.Cluster(config.clusterAddress);

var logger = require("log")("couchbase");
var csmError = require('../utils/csm-error.js');
var util = require('util');
var bucket, currentBucketConnection;

var timeoutCouchbaseConnectionRetryMs = (30 * 1000);
var timeoutObject;
var schedulerLockSet = false;
var EventEmitter = require('events').EventEmitter;
var bucketConnectionEventEmitter = new EventEmitter();
var couchbaseCluster = new couch.Cluster(config.clusterAddress);

// function clearBucketConnectionRetry() {
//     if (timeoutObject){
//         clearTimeout(timeoutObject);
//         logger.info("0", "msg=cleared timeout object timeoutObject.");
//     }
//     if (schedulerLockSet){
//         schedulerLockSet = false;
//     }
//     logger.info("0", "msg= clearBucketConnectionRetry()");
//
// }
//
// function scheduleBucketConnection() {
//     if (schedulerLockSet){
//         clearBucketConnectionRetry();
//     }
//     schedulerLockSet = true;
//     timeoutObject = setTimeout(function(){
//         logger.info("0","msg=Firing scheduled retry.");
//         connectBucket();
//     }, 5000);
//     logger.info("0", "msg= scheduleBucketConnection()", (timeoutCouchbaseConnectionRetryMs /1000 ));
// }

function connectBucket() {
    logger.info("0", "Creating new Couchbase bucket connection(currentBucketConnection)");
    schedulerLockSet = true;
    if (currentBucketConnection) {
        currentBucketConnection = null;
    }
    currentBucketConnection = new couch.Cluster(config.clusterAddress).openBucket(config.bucketName, config.bucketPassword);

    currentBucketConnection.on('connect', function () {
        logger.info("0", "msg=Successfully connected to new Couchbase bucket.");
        if (timeoutObject) {
            clearTimeout(timeoutObject);
            logger.info("0", "msg=cleared timeout object timeoutObject.");
        }
        if (schedulerLockSet) {
            schedulerLockSet = false;
        }
        logger.info("0", "msg= clearBucketConnectionRetry()");
        bucket = currentBucketConnection;
        logger.info("0", "msg=Successfully connected new bucket to current connection.");
    });

    currentBucketConnection.on('error', function () {
        logger.error("0", "msg=Failed to connect to Couchbase bucket");
        if (schedulerLockSet) {
            if (timeoutObject) {
                clearTimeout(timeoutObject);
                logger.info("0", "msg=cleared timeout object timeoutObject.");
            }
            if (schedulerLockSet) {
                schedulerLockSet = false;
            }
            logger.info("0", "msg= clearBucketConnectionRetry()");
        }
        schedulerLockSet = true;
        timeoutObject = setTimeout(function () {
            logger.info("0", "msg=Firing scheduled retry.");
            connectBucket();
        }, 5000);
        logger.info("0", "msg= scheduleBucketConnection()", (timeoutCouchbaseConnectionRetryMs / 1000 ));
    });

}


bucketConnectionEventEmitter.on('bucketDisconnect', function(){
    logger.error("0","msg=There was a bucket disconnect request event.");
    if (bucket){
        bucket.disconnect();
    }

});

bucketConnectionEventEmitter.on('bucketConnectionFailure', function () {
    logger.error("0","msg=There was a bucket connection failure event.");
    if(schedulerLockSet){
        logger.info("0","Bucket connection previously scheduled.");
    }else {
        logger.info("0","Bucket connection schedulerLockSet is false.");
        connectBucket();
    }
});

connectBucket();


var ViewQuery = couch.ViewQuery;


var sessionListMaxCacheDuration = generalConfig.sessionListMaxCacheDurationMillis/1000;

var BEGINNING_OF_TIME = new Date(0);

function getNewExpiry(sessionObj){
    if(sessionObj.activity === "RECORD"){
        var endTime = new Date(sessionObj.endTime || Date.now());
        endTime.setTime(endTime.getTime() + (generalConfig.numberOfIntervalsForExpiry * generalConfig.keepAliveInterval * 1000));
        return endTime.toISOString();
    }
    var expireDateByKeepAlive = new Date(Date.now() + (generalConfig.numberOfIntervalsForExpiry * generalConfig.keepAliveInterval * 1000));
    return  expireDateByKeepAlive.toISOString();
}

function getDateArray(date){
    var arr = [];
    arr.push(date.getUTCFullYear());
    arr.push(date.getUTCMonth()+1);
    arr.push(date.getUTCDate());
    arr.push(date.getUTCHours());
    arr.push(date.getUTCMinutes());
    arr.push(date.getUTCSeconds());
    return arr;
}

function getValues(resp){
    return resp.value;
}

function closeBucket() {
    bucket.disconnect();
    logger.info(0,"msg=bucket disconnected.");
    return true;
}


module.exports = {
    disconnect: function () {
        bucketConnectionEventEmitter.emit('bucketDisconnect');
    },
    createUid : function() {
        return uuid.v4();
    },
    addSession: function (sessionObj,callback){
        logger.info(sessionObj.fcid,"msg=inserting session object to couchbase");
        try{
            sessionObj.expireAt = getNewExpiry(sessionObj);
            //Remove the client headers before inserting to storage
            sessionObj.requestHeaders = undefined;
            bucket.insert(sessionObj._id, sessionObj, function(err,response){
                if(err){
                    logger.error(sessionObj.fcid,util.format("failed to insert session object to DB err: %s",err));
                    bucketConnectionEventEmitter.emit('bucketConnectionFailure');
                    callback(csmError.createCsmError("GENERIC_SESSION_CACHE_CREATE_ERROR", err), null);
                }
                else{
                    logger.info(sessionObj.fcid, util.format("msg=\"created session object in DB: %j\"",response));
                    callback(null,sessionObj);
                }
            });
        }catch(err){
            logger.error(sessionObj.fcid, util.format("\"Couchbase addSession returned error %s with reason %s\"", err.code, (err.message || null)));
            bucketConnectionEventEmitter.emit('bucketConnectionFailure');
            callback(csmError.createCsmError("GENERIC_SESSION_CACHE_CREATE_ERROR", err));
        }
    },
    getSession : function (requestHeaders,sessionId,callback){
        logger.info(requestHeaders.fcid,"msg=fetching session object from DB for sessionId= " + sessionId);
        try{
            bucket.get(sessionId, function(err,resp){
                if (err) {
                    logger.error(requestHeaders.fcid, util.format("\"Couchbase getSession returned error %s with reason %s\"", err.code, (err.reason || null)));
                    if (err.code === 13) {
                        callback(csmError.createCsmError("NOT_FOUND", err));
                    } else {
                        bucketConnectionEventEmitter.emit('bucketConnectionFailure');
                        callback(csmError.createCsmError("GENERIC_SESSION_CACHE_FIND_ERROR", err), null);
                    }
                }
                else {
                    var parsedResp = resp.value;
                    parsedResp.requestHeaders = requestHeaders;
                    callback(null, parsedResp);
                }
            });
        }catch(err){
            logger.error(requestHeaders.fcid, util.format("\"Couchbase getSession returned error %s with reason %s\"", err.code, (err.message || null)));
            bucketConnectionEventEmitter.emit('bucketConnectionFailure');
            callback(csmError.createCsmError("GENERIC_SESSION_CACHE_FIND_ERROR", err));
        }

    },
    removeSession : function (fcid,sessionId,callback){
        logger.info(fcid, "msg=removing session object from DB for sessionId: " + sessionId);
        try {
            bucket.remove(sessionId, function (err, resp) {
                if (err) {
                    err.sessionId = sessionId;
                    logger.error(fcid, util.format("\"Couchbase removeSession returned error %s with reason %s\"", err.code, (err.reason || null)));
                    if (err.code === 13) {
                        callback(csmError.createCsmError("NOT_FOUND", err));
                    } else {
                        bucketConnectionEventEmitter.emit('bucketConnectionFailure');
                        callback(csmError.createCsmError("GENERIC_SESSION_CACHE_REMOVE_ERROR", err), null);
                    }
                }
                else {
                    if (resp) {
                        resp.sessionId = sessionId;
                    } else {
                        resp = {'sessionId': sessionId};
                    }
                    callback(null, resp);
                }
            });
        } catch (err) {
            logger.error(fcid, util.format("\"Couchbase removeSession returned error %s with reason %s\"", err.code, (err.message || null)));
            bucketConnectionEventEmitter.emit('bucketConnectionFailure');
            callback(csmError.createCsmError("GENERIC_SESSION_CACHE_REMOVE_ERROR", err));
        }

    },
    updateSession : function (fcid,sessionId,sessionParams,callback){
        logger.info(fcid,util.format("msg=updating session object from DB sessionId=%s",sessionId));
        try{
            sessionParams.expireAt = getNewExpiry(sessionParams);
            sessionParams.lastUpdateTime = new Date().toISOString();
            bucket.replace(sessionId, sessionParams, callback);
        }catch(err){
            callback(err);
        }
    },
    getExpiredSessions : function(callback){
        var fromTimeDateArray = getDateArray(BEGINNING_OF_TIME);
        var endTimeDateArray = getDateArray(new Date(Date.now()));
        logger.info(0,util.format("msg=querying session objects byExpired from DB for time between %s and %s ", moment.utc(fromTimeDateArray).format("YYYY-MM-DD HH:mm:ss:SSS"), moment.utc(endTimeDateArray).format("YYYY-MM-DD HH:mm:ss:SSS")));

        var query = ViewQuery.from('csm', 'byExpired')
            .stale(ViewQuery.Update.BEFORE)
            .range(fromTimeDateArray, endTimeDateArray);
        try{
            bucket.query(query, function(err, resp){
                if (err || !resp){
                    logger.error(0, util.format("msg=\"getExpiredSessions returned error: %j\"", err));
                    callback(null,[]);
                }
                else{

                    logger.debug(0,util.format("msg=\"result of byExpired query returned from DB for time between %s and %s: %j\"",  moment.utc(fromTimeDateArray).format("YYYY-MM-DD HH:mm:ss:SSS"), moment.utc(endTimeDateArray).format("YYYY-MM-DD HH:mm:ss:SSS"), resp.map(getValues)));
                    callback(null, resp.map(getValues));
                }
            });
        }
        catch(err){
            callback(null,[]);
        }
    },
    getSessionsPerDevice : function(fcid, deviceId, callback){
        logger.info(fcid, util.format("msg=fetching all sessions for device ID from DB deviceId=%s",deviceId));
        var query = ViewQuery.from('csm', 'byDevice')
            .stale(ViewQuery.Update.BEFORE)
            .key(deviceId);
        var responseMap;
        try{
            bucket.query(query, function (err, response) {
                if (err) {
                    logger.error(fcid, util.format("\"Couchbase getSessionsPerDevice returned error %s with reason %s\"", err.code, (err.reason || null)));
                    if (err.code === 13) {
                        callback(csmError.createCsmError("NOT_FOUND", err), null);
                    } else {
                        bucketConnectionEventEmitter.emit('bucketConnectionFailure');
                        callback(csmError.createCsmError("GENERIC_SESSION_CACHE_FIND_ERROR", err), null);
                    }
                } else {
                    responseMap = response.map(getValues);
                    if (responseMap.length === 0) {
                        callback(csmError.createCsmError("NOT_FOUND", err), null);
                    } else {
                        logger.debug(fcid, util.format("msg=\"result of byDevice query returned from DB for deviceId :  %s %j\" ", deviceId, response.map(getValues)));
                        callback(null, responseMap);
                    }
                }
            });
        }
        catch(err){
            logger.error(fcid, util.format("\"Couchbase getSessionsPerDevice returned error %s with reason %s\"", err.code, (err.message || null)));
            bucketConnectionEventEmitter.emit('bucketConnectionFailure');
            callback(csmError.createCsmError("GENERIC_SESSION_CACHE_FIND_ERROR", err));
        }
    },
    getHouseholdSessions : function(fcid, householdId, callback){
        logger.info(fcid,util.format("msg=fetching all sessions for household from DB householdId=%s",householdId));
        var query = ViewQuery.from('csm', 'byHousehold')
            .stale(ViewQuery.Update.BEFORE)
            .key(householdId);
        var responseMap;
        try{
            bucket.query(query, function (err, response) {
                if (err) {
                    logger.error(fcid, util.format("\"Couchbase getHouseholdSessions returned error %s with reason %s. Err=%j\"", err.code, (err.reason || null), err));
                    if (err.code === 13) {
                        callback(csmError.createCsmError("NOT_FOUND", err), null);
                    } else {
                        bucketConnectionEventEmitter.emit('bucketConnectionFailure');
                        callback(csmError.createCsmError("GENERIC_SESSION_CACHE_FIND_ERROR", err), null);
                    }
                } else {
                    responseMap = response.map(getValues);
                    if (responseMap.length === 0) {
                        callback(csmError.createCsmError("NOT_FOUND", err), null);
                    } else {
                        logger.debug(fcid, util.format("msg=\"result set getHouseholdSessions query returned from DB for householdId :  %s %j\" ", householdId, response.map(getValues)));
                        callback(null, responseMap);
                    }
                }
            });
        }
        catch(err){
            logger.error(fcid, util.format("\"Couchbase getHouseholdSessions returned error %s with reason %s\"", err.code, (err.message || null)));
            bucketConnectionEventEmitter.emit('bucketConnectionFailure');
            callback(csmError.createCsmError("GENERIC_SESSION_CACHE_FIND_ERROR",err));
        }
    },
    deleteExpiredSessions : function(sessionIds, callback){
        logger.info(0,"msg=About to delete all expired sessions from storage");
        sessionIds.forEach(function(sessionId){
            try{
                bucket.remove(sessionId,function(err,resp){
                    if (err){
                        logger.error("0",util.format("msg=failed to remove session from storage, sessionId=%s",sessionId));
                        logger.debug(0, util.format("msg=\"deleteExpiredSessions returned error: %j\"", err));
                    }
                    else{
                        logger.debug("0",util.format("msg=session was removed from storage, sessionId=%s", sessionId));
                    }
                });
            }catch(err){
                logger.error(err);
            }
        });
        callback();
    },
    getListOfTuningParams : function(fcid,region,callback){
        logger.info(fcid,"msg=fetching sessionList from DB for region=" + region);
        try{
            bucket.get(region, function(err,resp){
                if(err){
                    logger.info(fcid, util.format("\"Couchbase getSession returned error %s with reason %s\"", err.code, (err.reason || null)));
                    callback();
                }
                else{
                    var parsedResp = resp.value;
                    callback(null, parsedResp);
                }
            });
        }catch(err2){
            callback(err2);
        }
    },
    addListOfTuningParams: function (fcid,region,sessionList){
        logger.info(fcid,"msg=inserting sessionList to couchbase region=" + region);
        try{
            bucket.insert(region, sessionList,{expiry : sessionListMaxCacheDuration}, function(err,response){
                if(err){
                    logger.error(fcid,"failed to insert session object to DB err :",err);
                }
                else{
                    logger.info(fcid, util.format("msg=\"created session list in DB: %j\"",response));
                }
            });
        }catch(err2){
            logger.error(fcid,"failed to insert session object to DB err :",err2);
        }
    }
};

/**
 * Created by moscohen on 1/2/16.
 */
