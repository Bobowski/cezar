import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { API_PREFIX, PROJECT_ICON_MAX_BYTES, PROJECT_NAME_MAX_LENGTH, type ProjectListEntry } from '@open-mercato/cezar-api-client'
import { getProjectIconCandidates, removeProjectIcon, setProjectIcon } from '@/api/client'
import { useUpdateProject, workspaceQueryKeys } from '@/api/queries'
import { ProjectIcon } from '@/components/project-icon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { SettingsField, SettingsGroup, SettingsNote } from './settings-field'

/** A file's bytes as base64 — what `PUT …/icon` takes. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

const folderName = (root: string): string => root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root

/**
 * Settings → project → General → Identity (spec 2026-10-12-project-identity): the name and the
 * icon the cockpit shows for this project. Cosmetic by construction — the project's id, its
 * URLs and its folder are not touched, so nothing saved or linked breaks on a rename.
 */
export function ProjectIdentity({ project }: { project: ProjectListEntry }) {
  const queryClient = useQueryClient()
  const update = useUpdateProject()
  const [name, setName] = useState(project.name)
  useEffect(() => setName(project.name), [project.id, project.name])
  const fileRef = useRef<HTMLInputElement>(null)

  const candidates = useQuery({
    queryKey: ['workspace', 'project-icon-candidates', project.id],
    queryFn: ({ signal }) => getProjectIconCandidates(project.id, { signal }),
    staleTime: 60_000,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
  const icon = useMutation({
    mutationFn: (input: { data: string } | { path: string } | null) => (input === null ? removeProjectIcon(project.id) : setProjectIcon(project.id, input)),
    onSuccess: async (_result, input) => { await refresh(); toast(input === null ? 'Icon removed' : 'Icon updated') },
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })

  const trimmed = name.trim()
  const rename = (next: string | null) =>
    update.mutate({ id: project.id, name: next }, {
      onSuccess: () => toast(next === null ? 'Name reset to the folder’s' : `Renamed to ${next}`),
      onError: (error: Error) => toast(error.message, { tone: 'danger' }),
    })
  const upload = async (file: File | undefined) => {
    if (!file) return
    if (file.size > PROJECT_ICON_MAX_BYTES) return toast(`An icon is at most ${PROJECT_ICON_MAX_BYTES / 1024} KB.`, { tone: 'danger' })
    icon.mutate({ data: await toBase64(file) })
  }
  const found = candidates.data?.candidates ?? []

  return (
    <SettingsGroup title="Identity" description="How this project appears in the cockpit. Its address and its folder stay as they are.">
      <SettingsField title="Name" htmlFor="project-name" hint="Shown in the project list, the breadcrumb and the browser tab.">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed !== '' && trimmed !== project.name) rename(trimmed)
          }}
        >
          <Input id="project-name" value={name} maxLength={PROJECT_NAME_MAX_LENGTH} onChange={(event) => setName(event.target.value)} autoComplete="off" className="max-w-sm" />
          <Button type="submit" disabled={update.isPending || trimmed === '' || trimmed === project.name}>Save name</Button>
          {project.name !== folderName(project.root) ? (
            <Button type="button" variant="outline" disabled={update.isPending} onClick={() => rename(null)}>Use the folder’s name</Button>
          ) : null}
        </form>
      </SettingsField>

      <SettingsField title="Icon" hint="A logo or a favicon: PNG, JPEG, WebP, GIF, SVG or ICO, up to 512 KB. Without one the project shows its first letter.">
        <div className="flex flex-wrap items-center gap-3">
          <ProjectIcon project={project} size="lg" />
          <Input
            ref={fileRef}
            type="file"
            aria-label="Icon file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/x-icon,.ico"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = '' }}
          />
          <Button type="button" variant="outline" disabled={icon.isPending} onClick={() => fileRef.current?.click()}>Upload an image…</Button>
          {project.icon ? <Button type="button" variant="outline" disabled={icon.isPending} onClick={() => icon.mutate(null)}>Remove</Button> : null}
        </div>
        {found.length > 0 ? (
          <div data-slot="project-icon-candidates" className="flex flex-col gap-2">
            <SettingsNote>Found in this repository — click one to use it:</SettingsNote>
            <div className="flex flex-wrap gap-2">
              {found.map((path) => (
                <Button key={path} type="button" variant="outline" size="icon-lg" aria-label={`Use ${path}`} title={path} disabled={icon.isPending} onClick={() => icon.mutate({ path })} className="overflow-hidden p-1">
                  <img
                    src={`${API_PREFIX}/p/${encodeURIComponent(project.id)}/repo/files?path=${encodeURIComponent(path)}&raw=1`}
                    alt=""
                    className="size-full object-contain"
                  />
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </SettingsField>
    </SettingsGroup>
  )
}
