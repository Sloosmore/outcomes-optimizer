export const vertexShader = /* glsl */ `
uniform float uTime;
uniform sampler2D uPerlinTexture;
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const fragmentShader = /* glsl */ `
uniform float uTime;
uniform float uAnimation;
uniform float uInverted;
uniform float uOffsets[7];
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uInputVolume;
uniform float uOutputVolume;
uniform float uOpacity;
uniform sampler2D uPerlinTexture;
varying vec2 vUv;

const float PI = 3.14159265358979323846;

bool drawOval(vec2 polarUv, vec2 polarCenter, float a, float b, bool reverseGradient, float softness, out vec4 color) {
    vec2 p = polarUv - polarCenter;
    float oval = (p.x * p.x) / (a * a) + (p.y * p.y) / (b * b);
    float edge = smoothstep(1.0, 1.0 - softness, oval);
    if (edge > 0.0) {
        float gradient = reverseGradient ? (1.0 - (p.x / a + 1.0) / 2.0) : ((p.x / a + 1.0) / 2.0);
        gradient = mix(0.5, gradient, 0.1);
        color = vec4(vec3(gradient), 0.85 * edge);
        return true;
    }
    return false;
}

vec3 colorRamp(float grayscale, vec3 color1, vec3 color2, vec3 color3, vec3 color4) {
    if (grayscale < 0.33) return mix(color1, color2, grayscale * 3.0);
    else if (grayscale < 0.66) return mix(color2, color3, (grayscale - 0.33) * 3.0);
    else return mix(color3, color4, (grayscale - 0.66) * 3.0);
}

vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float noise2D(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float n = mix(
        mix(dot(hash2(i + vec2(0.0,0.0)), f - vec2(0.0,0.0)), dot(hash2(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x),
        mix(dot(hash2(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)), dot(hash2(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
    return 0.5 + 0.5 * n;
}

float sharpRing(vec3 decomposed, float time) {
    float noise = mix(noise2D(vec2(decomposed.x, time) * 5.0), noise2D(vec2(decomposed.y, time) * 5.0), decomposed.z);
    return 1.0 + (noise - 0.5) * 2.5 * 0.3;
}

float smoothRing(vec3 decomposed, float time) {
    float noise = mix(noise2D(vec2(decomposed.x, time) * 6.0), noise2D(vec2(decomposed.y, time) * 6.0), decomposed.z);
    return 0.9 + (noise - 0.5) * 5.0 * 0.2;
}

float flow(vec3 decomposed, float time) {
    return mix(texture(uPerlinTexture, vec2(time, decomposed.x / 2.0)).r, texture(uPerlinTexture, vec2(time, decomposed.y / 2.0)).r, decomposed.z);
}

void main() {
    vec2 uv = vUv * 2.0 - 1.0;
    float radius = length(uv);
    float theta = atan(uv.y, uv.x);
    if (theta < 0.0) theta += 2.0 * PI;

    vec3 decomposed = vec3(theta / (2.0 * PI), mod(theta / (2.0 * PI) + 0.5, 1.0) + 1.0, abs(theta / PI - 1.0));

    float noise = flow(decomposed, radius * 0.03 - uAnimation * 0.2) - 0.5;
    theta += noise * mix(0.08, 0.25, uOutputVolume);

    vec4 color = vec4(1.0, 1.0, 1.0, 1.0);
    float originalCenters[7] = float[7](0.0, 0.5*PI, 1.0*PI, 1.5*PI, 2.0*PI, 2.5*PI, 3.0*PI);
    float centers[7];
    for (int i = 0; i < 7; i++) centers[i] = originalCenters[i] + 0.5 * sin(uTime / 20.0 + uOffsets[i]);

    vec4 ovalColor;
    for (int i = 0; i < 7; i++) {
        float n = texture(uPerlinTexture, vec2(mod(centers[i] + uTime * 0.05, 1.0), 0.5)).r;
        float a = 0.5 + n * 0.3;
        float b = n * mix(3.5, 2.5, uInputVolume);
        float distTheta = min(abs(theta - centers[i]), min(abs(theta + 2.0*PI - centers[i]), abs(theta - 2.0*PI - centers[i])));
        if (drawOval(vec2(distTheta, radius), vec2(0.0,0.0), a, b, (i % 2 == 1), 0.6, ovalColor)) {
            color.rgb = mix(color.rgb, ovalColor.rgb, ovalColor.a);
            color.a = max(color.a, ovalColor.a);
        }
    }

    float ringRadius1 = sharpRing(decomposed, uTime * 0.1);
    float ringRadius2 = smoothRing(decomposed, uTime * 0.1);
    float ringAlpha1 = ((radius + uInputVolume * 0.15) >= ringRadius1) ? mix(0.2, 0.6, uInputVolume) : 0.0;
    float ringAlpha2 = smoothstep(ringRadius2 - 0.05, ringRadius2 + 0.05, radius + uInputVolume * 0.2) * mix(0.15, 0.45, uInputVolume);
    color.rgb = 1.0 - (1.0 - color.rgb) * (1.0 - vec3(1.0) * max(ringAlpha1, ringAlpha2));

    float luminance = mix(color.r, 1.0 - color.r, uInverted);
    color.rgb = colorRamp(luminance, vec3(0.0), uColor1, uColor2, vec3(1.0));
    color.a *= uOpacity;
    gl_FragColor = color;
}
`
