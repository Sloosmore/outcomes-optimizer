import { useTheme } from '@/hooks/use-theme'

export function Wallpaper() {
  const theme = useTheme()
  const wallpaperUrl = theme === 'dark' ? '/wallpapers/12-Dark.jpg' : '/wallpapers/12-Light.jpg'

  return (
    <div
      aria-hidden
      className="absolute inset-0 bg-background"
      style={{
        backgroundImage: `url('${wallpaperUrl}')`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
      }}
    />
  )
}
