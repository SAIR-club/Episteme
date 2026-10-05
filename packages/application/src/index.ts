export * from './session.js'
/** Re-exported so a surface can tell "another surface owns this graph" apart from every other failure. */
export { GraphLockedError } from '@episteme/storage-local'
