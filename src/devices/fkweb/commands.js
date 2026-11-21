'use strict';

const { encodeBody, fkNow } = require('./codec');

/** Perintah yang dipakai server ini. */
const COMMANDS = {
  GET_LOG_DATA: 'GET_LOG_DATA',
  GET_USER_ID_LIST: 'GET_USER_ID_LIST',
  GET_USER_INFO: 'GET_USER_INFO',
  SET_TIME: 'SET_TIME',
  SET_COMMAND: 'SET_COMMAND',
};

/** Body perintah = cmd_param FkWeb (JSON + NUL, atau kosong). */
function buildParam(payload) {
  return payload === undefined || payload === null ? Buffer.alloc(0) : encodeBody(payload);
}

function setTimeParam() {
  return encodeBody({ time: fkNow() });
}

function getUserInfoParam(userId) {
  return encodeBody({ user_id: String(userId) });
}

function enrollParam(userId, backupNumber = 0) {
  return encodeBody({
    cmd: 'enter_enroll',
    param: { user_id: String(userId), backup_number: Number(backupNumber) || 0 },
  });
}

module.exports = {
  COMMANDS,
  buildParam,
  setTimeParam,
  getUserInfoParam,
  enrollParam,
};