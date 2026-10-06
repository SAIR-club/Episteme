import { formatDistillDemo, runDistillDemo } from './demo.js'

const result = await runDistillDemo()
process.stdout.write(`EPISTEME DISTILL SESSION\n\n${formatDistillDemo(result)}\n`)
