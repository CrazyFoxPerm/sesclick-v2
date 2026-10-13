import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(process.cwd())
const sourceDir = join(root, "extension-src")
const outputDir = join(root, "extension")
const iconSvg = join(root, "icon.svg")

import { existsSync } from "node:fs"

mkdirSync(outputDir, { recursive: true })
for (const entry of existsSync(outputDir) ? readdirSync(outputDir, { withFileTypes: true }) : []) {
  if (entry.isFile() && entry.name.endsWith(".js")) {
    unlinkSync(join(outputDir, entry.name))
  }
}
rmSync(join(outputDir, "injected"), { recursive: true, force: true })
mkdirSync(join(outputDir, "injected"), { recursive: true })
mkdirSync(join(outputDir, "icons"), { recursive: true })

copyFileSync(join(sourceDir, "manifest.json"), join(outputDir, "manifest.json"))

const sipsProbe = spawnSync("sips", ["--version"], { cwd: root, stdio: "ignore" })
if (sipsProbe.error) {
  const generators = [
    { name: "inkscape", args: (size, out) => [iconSvg, "-w", String(size), "-h", String(size), "-o", out] },
    { name: "magick", args: (size, out) => [iconSvg, "-resize", `${size}x${size}`, out] },
    { name: "convert", args: (size, out) => [iconSvg, "-resize", `${size}x${size}`, out] },
  ]
  let generator = null
  for (const candidate of generators) {
    const probe = spawnSync(candidate.name, ["--version"], { cwd: root, stdio: "ignore" })
    if (!probe.error) {
      generator = candidate
      break
    }
  }
  if (!generator) {
    const manifestPath = join(outputDir, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (manifest.action) {
      delete manifest.action.default_icon
    }
    delete manifest.icons
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    console.warn("warning: skipping icon generation (no SVG renderer available: inkscape/magick/convert all absent); stripped icon keys from the built manifest")
  } else {
    console.log(`generating icons with ${generator.name}`)
    for (const size of [16, 48, 128]) {
      const icon = spawnSync(
        generator.name,
        generator.args(size, join(outputDir, "icons", `icon${size}.png`)),
        { cwd: root, stdio: "inherit" }
      )
      if (icon.status !== 0) {
        process.exit(icon.status ?? 1)
      }
    }
  }
} else {
  for (const size of [16, 48, 128]) {
    const icon = spawnSync(
      "sips",
      ["-s", "format", "png", "-z", String(size), String(size), iconSvg, "--out", join(outputDir, "icons", `icon${size}.png`)],
      { cwd: root, stdio: "inherit" }
    )
    if (icon.status !== 0) {
      process.exit(icon.status ?? 1)
    }
  }
}

const build = spawnSync(
  "bun",
  [
    "build",
    join(sourceDir, "background.ts"),
    join(sourceDir, "injected", "dom.ts"),
    "--target=browser",
    "--format=esm",
    "--outdir",
    outputDir,
    "--entry-naming",
    "[dir]/[name].js",
  ],
  { cwd: root, stdio: "inherit" }
)

if (build.status !== 0) {
  process.exit(build.status ?? 1)
}
