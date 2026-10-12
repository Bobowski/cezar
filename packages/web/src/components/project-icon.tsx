import { API_PREFIX } from '@open-mercato/cezar-api-client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/** Where a project's icon is served. `version` is the registry's token: a new icon, a new URL. */
export function projectIconUrl(projectId: string, version: string): string {
  return `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/icon?v=${encodeURIComponent(version)}`
}

/**
 * A project's mark wherever projects are listed (spec 2026-10-12-project-identity): the icon the
 * user gave it, else the first letter of its name. Square with soft corners — a logo, not a face.
 */
export function ProjectIcon({
  project, size = 'sm', className, fallbackSlot,
}: {
  project: { id: string; name: string; icon?: string | undefined }
  size?: 'sm' | 'default' | 'lg'
  className?: string
  /** `data-slot` for the letter, where a caller has always exposed one. */
  fallbackSlot?: string
}) {
  return (
    <Avatar size={size} data-slot="project-icon" className={cn('rounded-md border bg-card', className)}>
      {project.icon ? <AvatarImage src={projectIconUrl(project.id, project.icon)} alt="" className="object-contain" /> : null}
      <AvatarFallback data-slot={fallbackSlot} className="rounded-md bg-card font-semibold text-foreground uppercase">
        {project.name.trim().charAt(0) || '·'}
      </AvatarFallback>
    </Avatar>
  )
}
