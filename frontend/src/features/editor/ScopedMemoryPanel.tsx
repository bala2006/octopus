import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/overlays";
import {
  archiveMemoryGroup,
  exactMemory,
  exactSource,
  listMemory,
  listMemoryGroups,
  memoryKey,
  saveMemoryGroup,
  writeMemory,
  type MemoryGroup,
  type MemoryNote,
  type MemoryScope,
  type MemorySource,
  type MemoryWrite,
} from "./scopedMemoryApi";

type Member = { id: string; name: string };
type Editor = {
  original: MemoryNote | null;
  key: string;
  content: string;
  verified: boolean;
  pinned: boolean;
};
type GroupEditor = { id: string | null; name: string; members: string[] };

export function ScopedMemoryPanel({
  workspace,
  companyId,
  runId,
  agents,
  agentId,
}: {
  workspace: string;
  companyId: string;
  runId?: string;
  agents: Member[];
  agentId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <BookOpen />
        Memory
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Memory and sources</DialogTitle>
          <DialogDescription>
            Review notes, inspect their original sources, and choose exactly who
            can read them. Proposed notes are observations, never instructions
            or proof.
          </DialogDescription>
          {open && (
            <MemoryContents
              workspace={workspace}
              companyId={companyId}
              runId={runId}
              agents={agents}
              agentId={agentId}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MemoryContents({
  workspace,
  companyId,
  runId,
  agents,
  agentId,
}: {
  workspace: string;
  companyId: string;
  runId?: string;
  agents: Member[];
  agentId?: string;
}) {
  const qc = useQueryClient();
  const key = memoryKey(workspace, companyId);
  const notes = useQuery({
    queryKey: [...key, runId ?? "all"],
    queryFn: () => listMemory(workspace, companyId, runId),
  });
  const groups = useQuery({
    queryKey: [...key, "groups"],
    queryFn: () => listMemoryGroups(workspace, companyId),
  });
  const [scope, setScope] = useState<MemoryScope>(
    agentId ? "agent" : runId ? "chat" : "project",
  );
  const [target, setTarget] = useState(agentId ?? runId ?? companyId);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [shareGroup, setShareGroup] = useState("");
  const [shareAcknowledged, setShareAcknowledged] = useState(false);
  const [groupEditor, setGroupEditor] = useState<GroupEditor | null>(null);
  const [lookupId, setLookupId] = useState("");
  const [source, setSource] = useState<{
    label: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
  };
  const save = useMutation({
    mutationFn: (value: MemoryWrite) =>
      writeMemory(workspace, companyId, value),
    onSuccess: () => {
      setEditor(null);
      refresh();
    },
  });
  const groupSave = useMutation({
    mutationFn: (value: GroupEditor) =>
      saveMemoryGroup(
        workspace,
        companyId,
        { name: value.name, members: value.members },
        value.id ?? undefined,
      ),
    onSuccess: () => {
      setGroupEditor(null);
      refresh();
    },
  });
  const archive = useMutation({
    mutationFn: (id: string) => archiveMemoryGroup(workspace, companyId, id),
    onSuccess: refresh,
  });
  const lookup = useMutation({
    mutationFn: (ref: MemorySource) => exactSource(workspace, companyId, ref),
    onSuccess: setSource,
  });
  const exact = useMutation({
    mutationFn: () => exactMemory(workspace, companyId, lookupId.trim()),
    onSuccess: (note) => {
      setSource({
        label: `${note.key} · ${note.scope} · v${note.version} · ${note.id}`,
        content: note.content,
        truncated: false,
      });
    },
  });
  const selectScope = (next: MemoryScope) => {
    setScope(next);
    setTarget(
      next === "agent"
        ? (agentId ?? agents[0]?.id ?? "")
        : next === "group"
          ? (groups.data?.find((group) => group.active)?.id ?? "")
          : next === "chat"
            ? (runId ?? "")
            : companyId,
    );
    setEditor(null);
  };
  const edit = (note: MemoryNote | null) => {
    setEditor({
      original: note,
      key: note?.key ?? "",
      content: note?.content ?? "",
      verified: note?.classification === "verified",
      pinned: note?.pinned ?? false,
    });
    setShareGroup("");
    setShareAcknowledged(false);
  };
  const loadEditor = useMutation({
    mutationFn: (id: string) => exactMemory(workspace, companyId, id),
    onSuccess: edit,
  });
  const chosenGroup = groups.data?.find(
    (group) => group.id === shareGroup && group.active,
  );
  const saveNote = () => {
    if (
      !editor ||
      !editor.key.trim() ||
      !target ||
      (shareGroup && (!chosenGroup || !shareAcknowledged))
    )
      return;
    const original = editor.original;
    const destination = chosenGroup
      ? ({
          scope: "group",
          scope_id: chosenGroup.id,
          run_id: original?.run_id ?? runId ?? null,
        } satisfies Pick<MemoryWrite, "scope" | "scope_id" | "run_id">)
      : (original ?? {
          scope,
          scope_id: target,
          run_id: scope === "chat" ? target : null,
        });
    const existingShared =
      chosenGroup &&
      notes.data?.find(
        (note) =>
          note.scope === "group" &&
          note.scope_id === chosenGroup.id &&
          note.key === editor.key.trim(),
      );
    if (existingShared) return;
    save.mutate({
      scope: destination.scope,
      scope_id: destination.scope_id,
      run_id: destination.run_id,
      key: editor.key.trim(),
      content: editor.content,
      expected_version: chosenGroup ? 0 : (original?.version ?? 0),
      classification: editor.verified ? "verified" : "proposed",
      pinned: editor.pinned,
      sources:
        chosenGroup && original
          ? [{ kind: "memory", id: original.id }]
          : (original?.source_refs ?? []),
      share_sources: !!chosenGroup && shareAcknowledged,
    });
  };
  const sharedExists =
    !!chosenGroup &&
    notes.data?.some(
      (note) =>
        note.scope === "group" &&
        note.scope_id === chosenGroup.id &&
        note.key === editor?.key.trim(),
    );
  const audience = (group: MemoryGroup) =>
    group.members
      .map((id) => agents.find((agent) => agent.id === id)?.name ?? id)
      .join(", ");
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label>
          Scope{" "}
          <select
            aria-label="Memory scope"
            className="ml-1 rounded border bg-background px-2 py-1.5"
            value={scope}
            onChange={(event) => {
              const value = event.target.value;
              if (
                value === "agent" ||
                value === "group" ||
                value === "chat" ||
                value === "project"
              )
                selectScope(value);
            }}
          >
            {["agent", "group", "chat", "project"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {(scope === "agent" || scope === "group") && (
          <select
            aria-label="Memory owner"
            className="min-w-32 rounded border bg-background px-2 py-1.5"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
              setEditor(null);
            }}
          >
            <option value="">Choose {scope}</option>
            {scope === "agent"
              ? agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))
              : groups.data
                  ?.filter((group) => group.active)
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
          </select>
        )}
        {scope === "chat" && !runId && (
          <span className="text-muted-foreground">
            Open a conversation to view its memory.
          </span>
        )}
        <Button
          size="xs"
          variant="outline"
          className="ml-auto"
          disabled={!target}
          onClick={() => edit(null)}
        >
          <Plus />
          Note
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {scope === "agent"
          ? "Private to this agent."
          : scope === "group"
            ? `Shared with ${groups.data?.find((group) => group.id === target)?.name ?? "the selected group"}.`
            : scope === "chat"
              ? "Context for this conversation."
              : "Shared project knowledge for this team."}{" "}
        Editing keeps the same scope. Sharing creates a separate group note.
      </p>
      {(notes.isPending || groups.isPending) && (
        <p role="status">Loading memory…</p>
      )}
      {(notes.error || groups.error) && (
        <p role="alert" className="text-destructive">
          {notes.error?.message ?? groups.error?.message}
        </p>
      )}
      <div className="max-h-56 space-y-2 overflow-auto pr-1">
        {notes.data
          ?.filter((note) => note.scope === scope && note.scope_id === target)
          .map((note) => (
            <article key={note.id} className="rounded-lg border p-2.5">
              <div className="flex items-center gap-2">
                <strong className="truncate font-medium">{note.key}</strong>
                <span className="text-[10px] text-muted-foreground">
                  {note.pinned ? "Pinned · " : ""}
                  {note.classification} · v{note.version}
                </span>
                <button
                  className="ml-auto text-primary underline"
                  disabled={loadEditor.isPending}
                  onClick={() => loadEditor.mutate(note.id)}
                >
                  Review / edit
                </button>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                {note.content}
              </p>
              <p className="mt-1 break-all font-mono text-[10px]">
                Memory ID {note.id}
              </p>
              {note.source_refs.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-2">
                  {note.source_refs.map((ref) => (
                    <button
                      className="break-all text-left font-mono text-[10px] text-primary underline"
                      key={`${ref.kind}:${ref.id}`}
                      onClick={() => lookup.mutate(ref)}
                    >
                      {ref.kind}:{ref.id}
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))}
        {notes.data &&
          !notes.data.some(
            (note) => note.scope === scope && note.scope_id === target,
          ) && (
            <p className="py-3 text-muted-foreground">
              No notes in this scope.
            </p>
          )}
      </div>
      {loadEditor.error && (
        <p role="alert" className="text-destructive">
          {loadEditor.error.message}
        </p>
      )}
      {editor && (
        <form
          className="space-y-2 rounded-lg border bg-muted/20 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            saveNote();
          }}
        >
          <label className="block">
            Key
            <input
              aria-label="Memory key"
              className="mt-1 w-full rounded border bg-background px-2 py-1.5"
              value={editor.key}
              readOnly={!!editor.original}
              maxLength={200}
              onChange={(event) =>
                setEditor({ ...editor, key: event.target.value })
              }
              required
            />
          </label>
          <label className="block">
            Note
            <textarea
              aria-label="Memory note"
              className="mt-1 min-h-20 w-full rounded border bg-background p-2"
              value={editor.content}
              maxLength={50000}
              onChange={(event) =>
                setEditor({ ...editor, content: event.target.value })
              }
            />
          </label>
          <div className="flex gap-4">
            <label>
              <input
                type="checkbox"
                checked={editor.verified}
                onChange={(event) =>
                  setEditor({ ...editor, verified: event.target.checked })
                }
              />{" "}
              Reviewed / verified
            </label>
            <label>
              <input
                type="checkbox"
                checked={editor.pinned}
                onChange={(event) =>
                  setEditor({ ...editor, pinned: event.target.checked })
                }
              />{" "}
              Pin note
            </label>
          </div>
          {editor.original && (
            <label className="block">
              Share a copy with group
              <select
                aria-label="Share memory with group"
                className="ml-2 rounded border bg-background px-2 py-1"
                value={shareGroup}
                onChange={(event) => {
                  setShareGroup(event.target.value);
                  setShareAcknowledged(false);
                }}
              >
                <option value="">Keep current scope</option>
                {groups.data
                  ?.filter(
                    (group) =>
                      group.active && group.id !== editor.original?.scope_id,
                  )
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {chosenGroup && (
            <label className="block rounded border border-warning/40 p-2">
              <input
                aria-label="Confirm sharing memory"
                type="checkbox"
                checked={shareAcknowledged}
                onChange={(event) => setShareAcknowledged(event.target.checked)}
              />{" "}
              Share this note and its source with {audience(chosenGroup)}. The
              original stays in its current scope.
            </label>
          )}
          {sharedExists && (
            <p role="alert" className="text-destructive">
              This group already has a note with this key. Edit that note in its
              group scope.
            </p>
          )}
          {save.error && (
            <p role="alert" className="text-destructive">
              {save.error.message} Refresh and review the latest version before
              retrying a conflicting edit.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={
                save.isPending ||
                !target ||
                !!sharedExists ||
                (!!shareGroup && !shareAcknowledged)
              }
            >
              {chosenGroup ? "Share copy" : "Save note"}
            </Button>
          </div>
        </form>
      )}
      <details className="rounded-lg border p-2.5">
        <summary className="cursor-pointer font-medium">Sharing groups</summary>
        <div className="mt-2 space-y-2">
          {groups.data?.map((group) => (
            <div key={group.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p>
                  {group.name}
                  {!group.active && " · archived"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {audience(group)}
                </p>
              </div>
              {group.active && (
                <>
                  <button
                    className="text-primary underline"
                    onClick={() =>
                      setGroupEditor({
                        id: group.id,
                        name: group.name,
                        members: [...group.members],
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    className="text-muted-foreground underline"
                    disabled={archive.isPending}
                    onClick={() => archive.mutate(group.id)}
                  >
                    Archive
                  </button>
                </>
              )}
            </div>
          ))}
          <Button
            size="xs"
            variant="outline"
            onClick={() => setGroupEditor({ id: null, name: "", members: [] })}
          >
            Create group
          </Button>
          {groupEditor && (
            <div className="space-y-2 border-t pt-2">
              <input
                aria-label="Group name"
                placeholder="Group name"
                className="w-full rounded border bg-background p-2"
                value={groupEditor.name}
                maxLength={200}
                onChange={(event) =>
                  setGroupEditor({ ...groupEditor, name: event.target.value })
                }
              />
              <div className="flex flex-wrap gap-3">
                {agents.map((agent) => (
                  <label key={agent.id}>
                    <input
                      type="checkbox"
                      checked={groupEditor.members.includes(agent.id)}
                      onChange={(event) =>
                        setGroupEditor({
                          ...groupEditor,
                          members: event.target.checked
                            ? [...groupEditor.members, agent.id]
                            : groupEditor.members.filter(
                                (id) => id !== agent.id,
                              ),
                        })
                      }
                    />{" "}
                    {agent.name}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Saving gives selected members access to all notes in this group.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setGroupEditor(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  disabled={
                    !groupEditor.name.trim() ||
                    !groupEditor.members.length ||
                    groupSave.isPending
                  }
                  onClick={() => groupSave.mutate(groupEditor)}
                >
                  Save members
                </Button>
              </div>
            </div>
          )}
          {(groupSave.error || archive.error) && (
            <p role="alert" className="text-destructive">
              {groupSave.error?.message ?? archive.error?.message}
            </p>
          )}
        </div>
      </details>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          exact.mutate();
        }}
      >
        <input
          aria-label="Exact memory ID"
          placeholder="Look up original memory ID"
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 font-mono"
          value={lookupId}
          onChange={(event) => setLookupId(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={!lookupId.trim() || exact.isPending}
        >
          Look up
        </Button>
      </form>
      {(lookup.error || exact.error) && (
        <p role="alert" className="text-destructive">
          {lookup.error?.message ?? exact.error?.message}
        </p>
      )}
      {source && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="flex gap-2">
            <strong className="min-w-0 flex-1 break-all font-medium">
              {source.label}
            </strong>
            <button onClick={() => setSource(null)} aria-label="Close source">
              Close
            </button>
          </div>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-xs">
            {source.content}
          </pre>
          {source.truncated && (
            <p className="mt-1 text-muted-foreground">
              Source preview truncated. Open the original artifact or message
              for full details.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
