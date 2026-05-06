// Noise cancellation is a native Node.js module. It must NOT be imported from
// livekit-adapter.ts because that file is in the BFF Vercel serverless function
// import chain (token.ts → livekit-adapter.ts). Native modules cause Vercel to
// fail at build time. This file is ONLY imported by voice-agent.ts which runs
// in the LiveKit agent process, not on Vercel.
export { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node'
