export interface SyncResult {
  skillName: string
  sourcePath: string
  targetPath: string
  success: boolean
  error?: string
}

export interface SyncOptions {
  skillsRoot: string
  targetDir: string
  userSkillsRoot?: string
}
