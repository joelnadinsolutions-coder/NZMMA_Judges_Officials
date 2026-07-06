'use strict';
// Build-time compatibility shim for Node 24.x on Windows.
//
// Node 24 on Windows throws EISDIR from fs.readlink()/readlinkSync() when the
// target is a regular file (older Node, and POSIX, throw EINVAL). webpack and
// other build tools treat EINVAL as "this path is not a symlink" and carry on,
// but the unexpected EISDIR is uncaught and kills the build while it snapshots
// resolve dependencies. This translates the bogus EISDIR back into EINVAL.
//
// There are no symlinks in this project, so this only ever fires on the
// not-a-symlink path. It is a no-op on Node versions that behave correctly
// (Node 22 LTS), so it is safe to leave in place. Loaded via NODE_OPTIONS
// (--require) from the npm "dev"/"build" scripts so it also reaches Next's
// build worker processes.
const fs = require('fs');

function fixErr(e) {
  if (e && e.code === 'EISDIR' && e.syscall === 'readlink') {
    e.code = 'EINVAL';
    e.errno = -22;
    if (typeof e.message === 'string') e.message = e.message.replace('EISDIR', 'EINVAL');
  }
  return e;
}

const origSync = fs.readlinkSync;
fs.readlinkSync = function (...args) {
  try {
    return origSync.apply(this, args);
  } catch (e) {
    throw fixErr(e);
  }
};

const origCb = fs.readlink;
fs.readlink = function (...args) {
  const cb = args[args.length - 1];
  if (typeof cb === 'function') {
    args[args.length - 1] = (err, ...rest) => cb(err ? fixErr(err) : err, ...rest);
  }
  return origCb.apply(this, args);
};

if (fs.promises && fs.promises.readlink) {
  const origP = fs.promises.readlink;
  fs.promises.readlink = function (...args) {
    return origP.apply(this, args).catch((e) => {
      throw fixErr(e);
    });
  };
}
