"use client"

import { Suspense, useEffect, useMemo, useRef } from "react"
import { useTexture } from "@react-three/drei"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { cn } from "@/lib/utils"
import { vertexShader, fragmentShader } from "./elevenlabs-orb.glsl"
import { ORB_PERLIN_NOISE_URL } from "@/constants"

export type AgentState = null | "thinking" | "listening" | "talking"

const DEFAULT_COLORS: [string, string] = ["#CADCFC", "#A0B9D1"]

export type OrbProps = {
  colors?: [string, string]
  colorsRef?: React.RefObject<[string, string]>
  resizeDebounce?: number
  seed?: number
  agentState?: AgentState
  volumeMode?: "auto" | "manual"
  manualInput?: number
  manualOutput?: number
  inputVolumeRef?: React.RefObject<number>
  outputVolumeRef?: React.RefObject<number>
  getInputVolume?: () => number
  getOutputVolume?: () => number
  className?: string
}

export function Orb({
  colors = DEFAULT_COLORS, colorsRef, resizeDebounce = 0, seed,
  agentState = null, volumeMode = "auto", manualInput, manualOutput,
  inputVolumeRef, outputVolumeRef, getInputVolume, getOutputVolume, className,
}: OrbProps) {
  return (
    <div className={cn("relative w-full h-full [&_canvas]:!w-full [&_canvas]:!h-full", className)}>
      <Canvas resize={{ debounce: resizeDebounce }} gl={{ alpha: true, antialias: true, premultipliedAlpha: true }}>
        <Suspense fallback={null}>
        <Scene
          colors={colors} colorsRef={colorsRef} seed={seed} agentState={agentState}
          volumeMode={volumeMode} manualInput={manualInput} manualOutput={manualOutput}
          inputVolumeRef={inputVolumeRef} outputVolumeRef={outputVolumeRef}
          getInputVolume={getInputVolume} getOutputVolume={getOutputVolume}
        />
        </Suspense>
      </Canvas>
    </div>
  )
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function splitmix32(a: number) {
  return () => {
    a |= 0; a = (a + 0x9e3779b9) | 0
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad)
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97)
    return ((t = t ^ (t >>> 15)) >>> 0) / 4294967296
  }
}

type SceneProps = Omit<OrbProps, 'className' | 'resizeDebounce'> & { colors: [string, string]; agentState: AgentState; volumeMode: "auto" | "manual" }

function Scene({ colors, colorsRef, seed, agentState, volumeMode, manualInput, manualOutput, inputVolumeRef, outputVolumeRef, getInputVolume, getOutputVolume }: SceneProps) {
  const { gl } = useThree()
  const circleRef = useRef<THREE.Mesh<THREE.CircleGeometry, THREE.ShaderMaterial>>(null)
  const initialColorsRef = useRef<[string, string]>(colors)
  const targetColor1Ref = useRef(new THREE.Color(colors[0]))
  const targetColor2Ref = useRef(new THREE.Color(colors[1]))
  const animSpeedRef = useRef(0.1)
  const perlinNoiseTexture = useTexture(ORB_PERLIN_NOISE_URL)
  const agentRef = useRef<AgentState>(agentState)
  const modeRef = useRef<"auto" | "manual">(volumeMode)
  const manualInputRef = useRef(manualInput)
  const manualOutputRef = useRef(manualOutput)
  const getInputVolumeRef = useRef(getInputVolume)
  const getOutputVolumeRef = useRef(getOutputVolume)
  const curInRef = useRef(0); const curOutRef = useRef(0)

  useEffect(() => { agentRef.current = agentState }, [agentState])
  useEffect(() => { modeRef.current = volumeMode }, [volumeMode])
  useEffect(() => { manualInputRef.current = manualInput }, [manualInput])
  useEffect(() => { manualOutputRef.current = manualOutput }, [manualOutput])
  useEffect(() => { getInputVolumeRef.current = getInputVolume }, [getInputVolume])
  useEffect(() => { getOutputVolumeRef.current = getOutputVolume }, [getOutputVolume])
  useEffect(() => { targetColor1Ref.current = new THREE.Color(colors[0]); targetColor2Ref.current = new THREE.Color(colors[1]) }, [colors])

  useEffect(() => {
    const apply = () => {
      if (!circleRef.current) return
      circleRef.current.material.uniforms.uInverted.value = document.documentElement.classList.contains("dark") ? 1 : 0
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = gl.domElement
    const onContextLost = (event: Event) => { event.preventDefault(); setTimeout(() => gl.forceContextRestore(), 1) }
    canvas.addEventListener("webglcontextlost", onContextLost, false)
    return () => canvas.removeEventListener("webglcontextlost", onContextLost, false)
  }, [gl])

  // eslint-disable-next-line react-hooks/purity -- Math.random() is intentional for stable-per-mount seed generation
  const random = useMemo(() => splitmix32(seed ?? Math.floor(Math.random() * 2 ** 32)), [seed])
  const offsets = useMemo(() => new Float32Array(Array.from({ length: 7 }, () => random() * Math.PI * 2)), [random])

  const uniforms = useMemo(() => {
    // eslint-disable-next-line react-hooks/immutability -- Three.js texture configuration requires mutation
    perlinNoiseTexture.wrapS = THREE.RepeatWrapping
    // eslint-disable-next-line react-hooks/immutability -- Three.js texture configuration requires mutation
    perlinNoiseTexture.wrapT = THREE.RepeatWrapping
    const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    return {
      uColor1: new THREE.Uniform(new THREE.Color(initialColorsRef.current[0])),
      uColor2: new THREE.Uniform(new THREE.Color(initialColorsRef.current[1])),
      uOffsets: { value: offsets }, uPerlinTexture: new THREE.Uniform(perlinNoiseTexture),
      uTime: new THREE.Uniform(0), uAnimation: new THREE.Uniform(0.1),
      uInverted: new THREE.Uniform(isDark ? 1 : 0), uInputVolume: new THREE.Uniform(0),
      uOutputVolume: new THREE.Uniform(0), uOpacity: new THREE.Uniform(0),
    }
  }, [perlinNoiseTexture, offsets])

  useFrame((_, delta: number) => {
    const mat = circleRef.current?.material
    if (!mat) return
    const live = colorsRef?.current
    if (live) { if (live[0]) targetColor1Ref.current.set(live[0]); if (live[1]) targetColor2Ref.current.set(live[1]) }
    const u = mat.uniforms
    // eslint-disable-next-line react-hooks/immutability -- Three.js animation loop requires uniform mutation
    u.uTime.value += delta * 0.5
    if (u.uOpacity.value < 1) u.uOpacity.value = Math.min(1, u.uOpacity.value + delta * 2)

    let targetIn = 0, targetOut = 0.3
    if (modeRef.current === "manual") {
      targetIn = clamp01(manualInputRef.current ?? inputVolumeRef?.current ?? getInputVolumeRef.current?.() ?? 0)
      targetOut = clamp01(manualOutputRef.current ?? outputVolumeRef?.current ?? getOutputVolumeRef.current?.() ?? 0)
    } else {
      const t = u.uTime.value * 2
      if (agentRef.current === null) { targetIn = 0; targetOut = 0.3 }
      else if (agentRef.current === "listening") { targetIn = clamp01(0.55 + Math.sin(t * 3.2) * 0.35); targetOut = 0.45 }
      else if (agentRef.current === "talking") { targetIn = clamp01(0.65 + Math.sin(t * 4.8) * 0.22); targetOut = clamp01(0.75 + Math.sin(t * 3.6) * 0.22) }
      else { targetIn = clamp01(0.38 + 0.07 * Math.sin(t * 0.7)); targetOut = clamp01(0.48 + 0.12 * Math.sin(t * 1.05 + 0.6)) }
    }

    curInRef.current += (targetIn - curInRef.current) * 0.2
    curOutRef.current += (targetOut - curOutRef.current) * 0.2
    const targetSpeed = 0.1 + (1 - Math.pow(curOutRef.current - 1, 2)) * 0.9
    animSpeedRef.current += (targetSpeed - animSpeedRef.current) * 0.12
    u.uAnimation.value += delta * animSpeedRef.current
    u.uInputVolume.value = curInRef.current; u.uOutputVolume.value = curOutRef.current
    u.uColor1.value.lerp(targetColor1Ref.current, 0.08); u.uColor2.value.lerp(targetColor2Ref.current, 0.08)
  })

  return (
    <mesh ref={circleRef}>
      <circleGeometry args={[3.5, 64]} />
      <shaderMaterial uniforms={uniforms} fragmentShader={fragmentShader} vertexShader={vertexShader} transparent />
    </mesh>
  )
}
