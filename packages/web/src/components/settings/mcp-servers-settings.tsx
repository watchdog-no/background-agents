"use client";

import { useState, useCallback, useRef, type ClipboardEvent } from "react";
import { toast } from "sonner";
import type {
  CreateMcpServerRequest,
  McpServerMetadata,
  McpToolMetadata,
} from "@open-inspect/shared/types/integrations";
import { DEFAULT_MCP_SERVER_ENABLED } from "@open-inspect/shared/types/integrations";
import {
  useMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  discoverMcpTools,
} from "@/hooks/use-mcp-servers";
import { useRepos } from "@/hooks/use-repos";
import { parseMaybeEnvContent } from "@/lib/env-paste";
import {
  PlusIcon,
  TerminalIcon,
  GlobeIcon,
  ChevronRightIcon,
  SearchIcon,
  XIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RadioCard } from "@/components/ui/form-controls";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type ScopeMode = "global" | "selected";
type Editor =
  | { kind: "new"; draftId: string }
  | { kind: "existing"; draftId: string; id: string; revision: number };

type EnvRow = { id: string; key: string; value: string };

function createEnvRow(init?: { key: string; value: string }): EnvRow {
  return { id: crypto.randomUUID(), key: init?.key ?? "", value: init?.value ?? "" };
}

function envRowsToRecord(rows: EnvRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (k && row.value) result[k] = row.value;
  }
  return result;
}

type FormState = {
  name: string;
  type: "local" | "remote";
  command: string;
  url: string;
  envRows: EnvRow[];
  repoScopes: string[];
  scopeMode: ScopeMode;
  toolAllowlist: string[] | null;
  localToolAllowlist: string[] | null;
  remoteToolAllowlist: string[] | null;
  enabled: boolean;
};

const emptyForm: FormState = {
  name: "",
  type: "local",
  command: "",
  url: "",
  envRows: [createEnvRow()],
  repoScopes: [],
  scopeMode: "global",
  toolAllowlist: null,
  localToolAllowlist: null,
  remoteToolAllowlist: null,
  enabled: DEFAULT_MCP_SERVER_ENABLED,
};

function metadataToForm(metadata: McpServerMetadata): FormState {
  return {
    name: metadata.name,
    type: metadata.type,
    command:
      metadata.command
        ?.map((t) =>
          /[\s$`#!&|;<>(){}\\"]/.test(t) ? `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : t
        )
        .join(" ") ?? "",
    url: metadata.url ?? "",
    envRows: [createEnvRow()],
    repoScopes: metadata.repoScopes ?? [],
    scopeMode: metadata.repoScopes?.length ? "selected" : "global",
    toolAllowlist: metadata.toolAllowlist ?? null,
    localToolAllowlist: metadata.type === "local" ? (metadata.toolAllowlist ?? null) : null,
    remoteToolAllowlist: metadata.type === "remote" ? (metadata.toolAllowlist ?? null) : null,
    enabled: metadata.enabled,
  };
}

/** Minimal shell-quote aware parser: respects "..." and '...' grouping. */
function parseCommand(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function EnvRowsEditor({
  form,
  setForm,
  hasExistingCredentials,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
  hasExistingCredentials?: boolean;
}) {
  const isRemote = form.type === "remote";
  const label = isRemote ? "HTTP Headers" : "Environment Variables";
  const keyPlaceholder = isRemote ? "Header-Name" : "KEY_NAME";
  const valuePlaceholder = isRemote ? "value" : "value";

  const updateRow = useCallback(
    (id: string, field: "key" | "value", val: string) => {
      setForm({
        ...form,
        envRows: form.envRows.map((r) => (r.id === id ? { ...r, [field]: val } : r)),
      });
    },
    [form, setForm]
  );

  const removeRow = useCallback(
    (id: string) => {
      const next = form.envRows.filter((r) => r.id !== id);
      setForm({ ...form, envRows: next.length > 0 ? next : [createEnvRow()] });
    },
    [form, setForm]
  );

  const addRow = useCallback(() => {
    setForm({ ...form, envRows: [...form.envRows, createEnvRow()] });
  }, [form, setForm]);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      const text = event.clipboardData.getData("text");
      const parsed = parseMaybeEnvContent(text);
      if (parsed.length === 0) return;

      event.preventDefault();

      const next = [...form.envRows];
      const keyToIndex = new Map<string, number>();
      next.forEach((row, i) => {
        if (row.key.trim()) keyToIndex.set(row.key.trim(), i);
      });

      for (const entry of parsed) {
        const existing = keyToIndex.get(entry.key);
        if (existing !== undefined) {
          next[existing] = { ...next[existing], key: entry.key, value: entry.value };
          continue;
        }
        const emptyIdx = next.findIndex(
          (r) => !keyToIndex.has(r.key.trim()) && !r.key.trim() && !r.value.trim()
        );
        if (emptyIdx >= 0) {
          next[emptyIdx] = { ...next[emptyIdx], key: entry.key, value: entry.value };
          keyToIndex.set(entry.key, emptyIdx);
        } else {
          next.push(createEnvRow({ key: entry.key, value: entry.value }));
          keyToIndex.set(entry.key, next.length - 1);
        }
      }

      setForm({ ...form, envRows: next });
      toast.success(
        `Imported ${parsed.length} entr${parsed.length === 1 ? "y" : "ies"} from paste`
      );
    },
    [form, setForm]
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label>
          {label} <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Button type="button" variant="subtle" size="xs" onClick={addRow}>
          + Add
        </Button>
      </div>
      {hasExistingCredentials && form.envRows.every((r) => !r.value.trim()) && (
        <p className="text-xs text-muted-foreground mb-1">
          Credentials are configured. Enter new values to replace them, or leave empty to keep
          existing.
        </p>
      )}
      <div className="space-y-1.5">
        {form.envRows.map((row) => (
          <div key={row.id} className="flex gap-1.5">
            <Input
              value={row.key}
              onChange={(e) => updateRow(row.id, "key", e.target.value)}
              onPaste={handlePaste}
              placeholder={keyPlaceholder}
              className="flex-1 min-w-[140px] font-mono text-xs h-8"
            />
            <Input
              type="password"
              value={row.value}
              onChange={(e) => updateRow(row.id, "value", e.target.value)}
              onPaste={handlePaste}
              placeholder={valuePlaceholder}
              className="flex-1 min-w-[180px] font-mono text-xs h-8"
            />
            <button
              type="button"
              onClick={() => removeRow(row.id)}
              className="px-1.5 text-muted-foreground hover:text-destructive transition"
              aria-label="Remove"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Paste a <code className="text-xs">.env</code> block into any field to import multiple
        entries.
      </p>
    </div>
  );
}

function ToolTag({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-muted px-2 py-1 font-mono text-xs">
      {name}
      <button type="button" onClick={onRemove} aria-label={`Remove ${name}`}>
        <XIcon className="h-3 w-3 text-muted-foreground hover:text-foreground" />
      </button>
    </span>
  );
}

function ManualToolAllowlistEditor({
  tools,
  onChange,
}: {
  tools: string[];
  onChange: (tools: string[]) => void;
}) {
  const [value, setValue] = useState("");

  function addTools(raw: string) {
    const additions = raw
      .split(/[\n,]/)
      .map((tool) => tool.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    onChange([...new Set([...tools, ...additions])]);
    setValue("");
  }

  return (
    <div className="space-y-2">
      {tools.length > 0 && (
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
          {tools.map((tool) => (
            <ToolTag
              key={tool}
              name={tool}
              onRemove={() => onChange(tools.filter((t) => t !== tool))}
            />
          ))}
        </div>
      )}
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== ",") return;
          event.preventDefault();
          addTools(value);
        }}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          if (!/[\n,]/.test(pasted)) return;
          event.preventDefault();
          addTools(pasted);
        }}
        onBlur={() => addTools(value)}
        placeholder="Add a tool name and press Enter"
        className="font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">
        Use server-native names such as <code className="text-xs">list_runs</code>. Paste comma- or
        newline-separated names to add several.
      </p>
    </div>
  );
}

function LocalToolVisibility({
  form,
  setForm,
  radioPrefix,
}: {
  form: FormState;
  setForm: (form: FormState) => void;
  radioPrefix: string;
}) {
  if (form.type !== "local") return null;
  const restricted = form.toolAllowlist !== null;

  return (
    <div>
      <Label className="mb-1.5">Tool visibility</Label>
      <div className="mb-2 space-y-2">
        <RadioCard
          name={`tool-mode-${radioPrefix}`}
          checked={!restricted}
          onChange={() => setForm({ ...form, toolAllowlist: null })}
          label="All tools"
          description="Expose every tool advertised by this local MCP"
        />
        <RadioCard
          name={`tool-mode-${radioPrefix}`}
          checked={restricted}
          onChange={() => setForm({ ...form, toolAllowlist: form.toolAllowlist ?? [] })}
          label="Selected tools only"
          description="Only expose the server-native tool names listed below"
        />
      </div>
      {form.toolAllowlist !== null && (
        <ManualToolAllowlistEditor
          tools={form.toolAllowlist}
          onChange={(toolAllowlist) => setForm({ ...form, toolAllowlist })}
        />
      )}
    </div>
  );
}

function RemoteToolVisibility({
  catalog,
  selected,
  loading,
  errorMessage,
  search,
  onSearchChange,
  onChange,
  onRefresh,
}: {
  catalog: McpToolMetadata[] | null;
  selected: string[] | null;
  loading: boolean;
  errorMessage: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onChange: (tools: string[] | null) => void;
  onRefresh: () => void;
}) {
  const catalogNames = new Set(catalog?.map((tool) => tool.name) ?? []);
  const selectedNames = new Set(selected ?? catalogNames);
  const unavailable =
    selected === null ? [] : [...selectedNames].filter((name) => !catalogNames.has(name)).sort();
  const selectedAvailableCount = [...selectedNames].filter((name) => catalogNames.has(name)).length;
  const normalizedSearch = search.trim().toLowerCase();
  const visible = (catalog ?? []).filter(
    (tool) =>
      !normalizedSearch ||
      tool.name.toLowerCase().includes(normalizedSearch) ||
      tool.description?.toLowerCase().includes(normalizedSearch)
  );

  function toggle(name: string, checked: boolean) {
    const next = new Set(selectedNames);
    if (checked) next.add(name);
    else next.delete(name);
    onChange(
      catalogNames.size > 0 &&
        next.size === catalogNames.size &&
        [...catalogNames].every((tool) => next.has(tool))
        ? null
        : [...next].sort()
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Label>Tool visibility</Label>
        <Button type="button" variant="subtle" size="xs" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </Button>
      </div>

      {errorMessage && (
        <div className="mb-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {errorMessage}
        </div>
      )}

      {catalog ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {selected === null
                ? `All tools (${catalog.length} available)`
                : `${selectedAvailableCount} selected / ${catalog.length} available`}
            </span>
            <span>
              {selected === null
                ? "Newly advertised tools are included"
                : "Newly advertised tools stay unchecked"}
            </span>
          </div>

          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search tools"
              className="pl-8"
            />
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="subtle"
              size="xs"
              onClick={() => {
                const next = new Set([...selectedNames, ...visible.map((tool) => tool.name)]);
                onChange(
                  catalogNames.size > 0 &&
                    next.size === catalogNames.size &&
                    [...catalogNames].every((tool) => next.has(tool))
                    ? null
                    : [...next].sort()
                );
              }}
            >
              Select filtered
            </Button>
            <Button
              type="button"
              variant="subtle"
              size="xs"
              onClick={() => {
                const visibleNames = new Set(visible.map((tool) => tool.name));
                onChange([...selectedNames].filter((name) => !visibleNames.has(name)).sort());
              }}
            >
              Clear filtered
            </Button>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-sm border border-border">
            {visible.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                No matching tools
              </p>
            ) : (
              visible.map((tool) => (
                <label
                  key={tool.name}
                  className="flex cursor-pointer items-start gap-2 border-b border-border-muted px-3 py-2 last:border-b-0 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectedNames.has(tool.name)}
                    onCheckedChange={(checked) => toggle(tool.name, checked === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-foreground">{tool.name}</span>
                    {tool.description && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {tool.description}
                      </span>
                    )}
                  </span>
                </label>
              ))
            )}
          </div>

          {unavailable.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">No longer advertised</p>
              <div className="flex flex-wrap gap-1">
                {unavailable.map((tool) => (
                  <ToolTag key={tool} name={tool} onRemove={() => toggle(tool, false)} />
                ))}
              </div>
            </div>
          )}
        </div>
      ) : selected !== null ? (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">
            {selectedNames.size} selected tool{selectedNames.size === 1 ? "" : "s"}
          </p>
          {unavailable.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {unavailable.map((tool) => (
                <ToolTag key={tool} name={tool} onRemove={() => toggle(tool, false)} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No tools selected</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface McpServerFormProps {
  form: FormState;
  setForm: (form: FormState) => void;
  repos: { fullName: string; private?: boolean }[];
  loadingRepos: boolean;
  radioPrefix: string;
  hasExistingCredentials?: boolean;
  showToolVisibility?: boolean;
}

function McpServerForm({
  form,
  setForm,
  repos,
  loadingRepos,
  radioPrefix,
  hasExistingCredentials,
  showToolVisibility = false,
}: McpServerFormProps) {
  const selectedRepoScopes = new Set(form.repoScopes);

  return (
    <>
      <div>
        <Label className="mb-1.5">Name</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. documentation"
        />
      </div>

      <div>
        <Label className="mb-1.5">Type</Label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() =>
              setForm({
                ...form,
                type: "local",
                envRows: form.type === "local" ? form.envRows : [createEnvRow()],
                toolAllowlist: form.type === "local" ? form.toolAllowlist : form.localToolAllowlist,
                remoteToolAllowlist:
                  form.type === "remote" ? form.toolAllowlist : form.remoteToolAllowlist,
              })
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
              form.type === "local"
                ? "border-foreground/30 text-foreground bg-muted"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <TerminalIcon className="w-3.5 h-3.5" />
            Local
          </button>
          <button
            type="button"
            onClick={() =>
              setForm({
                ...form,
                type: "remote",
                envRows: form.type === "remote" ? form.envRows : [createEnvRow()],
                toolAllowlist:
                  form.type === "remote" ? form.toolAllowlist : form.remoteToolAllowlist,
                localToolAllowlist:
                  form.type === "local" ? form.toolAllowlist : form.localToolAllowlist,
              })
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-sm border transition ${
              form.type === "remote"
                ? "border-foreground/30 text-foreground bg-muted"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <GlobeIcon className="w-3.5 h-3.5" />
            Remote
          </button>
        </div>
      </div>

      {form.type === "remote" ? (
        <div>
          <Label className="mb-1.5">URL</Label>
          <Input
            type="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://mcp.example.com/sse"
          />
        </div>
      ) : (
        <div>
          <Label className="mb-1.5">Command</Label>
          <Input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            placeholder="npx -y @playwright/mcp"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Space-separated command and arguments. Use quotes for arguments with spaces.
          </p>
        </div>
      )}

      <EnvRowsEditor
        form={form}
        setForm={setForm}
        hasExistingCredentials={hasExistingCredentials}
      />

      {showToolVisibility && (
        <LocalToolVisibility form={form} setForm={setForm} radioPrefix={radioPrefix} />
      )}

      <div>
        <Label className="mb-1.5">Availability</Label>
        <div className="space-y-2 mb-2">
          <RadioCard
            name={`scope-mode-${radioPrefix}`}
            checked={form.scopeMode === "global"}
            onChange={() => setForm({ ...form, scopeMode: "global", repoScopes: [] })}
            label="All repositories"
            description="Available in every agent session"
          />
          <RadioCard
            name={`scope-mode-${radioPrefix}`}
            checked={form.scopeMode === "selected"}
            onChange={() => setForm({ ...form, scopeMode: "selected" })}
            label="Selected repositories only"
            description="Only available in sessions for chosen repos"
          />
        </div>

        {form.scopeMode === "selected" && (
          <>
            {loadingRepos ? (
              <p className="text-sm text-muted-foreground px-3 py-2">Loading repositories...</p>
            ) : repos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-3 py-2 border border-border rounded-sm">
                No repositories available. Connect a GitHub integration first.
              </p>
            ) : (
              <div className="border border-border max-h-40 overflow-y-auto rounded-sm">
                {repos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = selectedRepoScopes.has(fullName);
                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => {
                          const next = isChecked
                            ? form.repoScopes.filter((r) => r !== fullName)
                            : [...form.repoScopes, fullName];
                          setForm({ ...form, repoScopes: next });
                        }}
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                      {repo.private && (
                        <span className="text-xs text-muted-foreground">private</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
            {form.repoScopes.length === 0 && repos.length > 0 && (
              <p className="text-xs text-warning mt-1">
                Select a repository or switch to &quot;All repositories&quot;.
              </p>
            )}
          </>
        )}
      </div>

      <label
        htmlFor={`mcp-enabled-${radioPrefix}`}
        className="flex items-center justify-between cursor-pointer"
      >
        <span className="text-sm text-foreground">Enabled</span>
        <Switch
          id={`mcp-enabled-${radioPrefix}`}
          checked={form.enabled}
          onCheckedChange={(checked) => setForm({ ...form, enabled: checked })}
        />
      </label>
    </>
  );
}

export function McpServersSettings() {
  const { servers, loading, mutate } = useMcpServers();
  const { repos, loading: loadingRepos } = useRepos();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [toolCatalog, setToolCatalog] = useState<McpToolMetadata[] | null>(null);
  const [loadingTools, setLoadingTools] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSearch, setToolSearch] = useState("");
  const activeDraftId = useRef<string | null>(null);

  function resetToolDiscovery() {
    setToolCatalog(null);
    setLoadingTools(false);
    setToolError(null);
    setToolSearch("");
  }

  async function loadRemoteTools(id: string, draftId: string) {
    setLoadingTools(true);
    setToolError(null);
    try {
      const tools = await discoverMcpTools(id);
      if (activeDraftId.current !== draftId) return;
      setToolCatalog(tools);
    } catch (err) {
      if (activeDraftId.current !== draftId) return;
      setToolError(err instanceof Error ? err.message : "Failed to load MCP tools");
    } finally {
      if (activeDraftId.current === draftId) setLoadingTools(false);
    }
  }

  function startNew() {
    setForm(emptyForm);
    resetToolDiscovery();
    const draftId = crypto.randomUUID();
    activeDraftId.current = draftId;
    setEditor({ kind: "new", draftId });
  }

  function startEdit(server: McpServerMetadata) {
    if (editor?.kind === "existing" && editor.id === server.id) {
      activeDraftId.current = null;
      setEditor(null);
    } else {
      resetToolDiscovery();
      const draftId = crypto.randomUUID();
      activeDraftId.current = draftId;
      setForm(metadataToForm(server));
      setEditor({
        kind: "existing",
        draftId,
        id: server.id,
        revision: server.revision,
      });
      if (server.type === "remote") void loadRemoteTools(server.id, draftId);
    }
  }

  function cancel() {
    activeDraftId.current = null;
    setEditor(null);
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (form.type === "remote" && !form.url.trim()) {
      toast.error("URL is required for remote servers");
      return;
    }
    if (form.type === "local" && !form.command.trim()) {
      toast.error("Command is required for local servers");
      return;
    }
    if (form.scopeMode === "selected" && form.repoScopes.length === 0) {
      toast.error("Select at least one repository or switch to All repositories");
      return;
    }

    const saveOwner = editor;
    if (!saveOwner) return;
    setSaving(true);

    try {
      const common = {
        name: form.name.trim(),
        enabled: form.enabled,
        toolAllowlist: form.toolAllowlist,
        repoScopes:
          form.scopeMode === "selected" && form.repoScopes.length > 0 ? form.repoScopes : null,
      };

      const envRecord = envRowsToRecord(form.envRows);
      const hasEnvValues = Object.keys(envRecord).length > 0;
      const includeCredentials = hasEnvValues || saveOwner.kind === "new";
      const payload: CreateMcpServerRequest =
        form.type === "remote"
          ? {
              ...common,
              type: "remote",
              url: form.url.trim(),
              ...(includeCredentials ? { headers: envRecord } : {}),
            }
          : {
              ...common,
              type: "local",
              command: parseCommand(form.command),
              ...(includeCredentials ? { env: envRecord } : {}),
            };

      if (saveOwner.kind === "new") {
        const created = await createMcpServer(payload);
        toast.success("MCP server created");
        setForm((current) =>
          activeDraftId.current === saveOwner.draftId ? metadataToForm(created) : current
        );
        setEditor((current) =>
          current?.draftId === saveOwner.draftId
            ? {
                kind: "existing",
                draftId: saveOwner.draftId,
                id: created.id,
                revision: created.revision,
              }
            : current
        );
        if (created.type === "remote") void loadRemoteTools(created.id, saveOwner.draftId);
      } else {
        await updateMcpServer(saveOwner.id, { ...payload, revision: saveOwner.revision });
        toast.success("MCP server updated");
        setEditor((current) => {
          if (current?.draftId !== saveOwner.draftId) return current;
          activeDraftId.current = null;
          return null;
        });
      }

      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMcpServer(id);
      mutate();
      if (editor?.kind === "existing" && editor.id === id) {
        setEditor(null);
      }
      toast.success("MCP server deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
    setDeleteTarget(null);
  }

  async function handleToggle(server: McpServerMetadata) {
    try {
      await updateMcpServer(server.id, {
        enabled: !server.enabled,
        revision: server.revision,
      });
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to toggle");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-foreground">MCP Servers</h2>
        <Button onClick={startNew} variant="outline" size="sm">
          <span className="inline-flex items-center gap-1">
            <PlusIcon className="w-3.5 h-3.5" />
            Add Server
          </span>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Configure Model Context Protocol servers that are available to agent sessions.
      </p>

      {/* New server form */}
      {editor?.kind === "new" && (
        <div className="border border-border rounded-md p-4 mb-6 space-y-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-foreground">New MCP Server</h3>
            <Button variant="ghost" size="icon" onClick={cancel} aria-label="Close">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
          <McpServerForm
            form={form}
            setForm={setForm}
            repos={repos}
            loadingRepos={loadingRepos}
            radioPrefix="new"
          />
          <div className="flex gap-2 pt-2">
            <Button onClick={save} disabled={saving} size="sm">
              {saving ? "Saving..." : "Add Server"}
            </Button>
            <Button onClick={cancel} variant="outline" size="sm">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Server list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : servers.length === 0 && editor?.kind !== "new" ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No MCP servers configured. Add one to extend agent capabilities.
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((server) => {
            const isExpanded = editor?.kind === "existing" && editor.id === server.id;
            return (
              <div
                key={server.id}
                className={`border rounded-md transition ${
                  server.enabled
                    ? "border-border bg-card"
                    : "border-border/50 bg-card/50 opacity-60"
                }`}
              >
                {/* Header row */}
                <div className="flex items-center justify-between px-4 py-3">
                  <button
                    type="button"
                    className="flex items-center gap-3 min-w-0 cursor-pointer text-left"
                    onClick={() => startEdit(server)}
                  >
                    <ChevronRightIcon
                      className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    />
                    {server.type === "remote" ? (
                      <GlobeIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    ) : (
                      <TerminalIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {server.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {server.type === "remote" ? server.url : server.command?.join(" ")}
                        {server.repoScopes?.length ? (
                          <span className="ml-2 text-accent">
                            •{" "}
                            {server.repoScopes.length === 1
                              ? server.repoScopes[0]
                              : `${server.repoScopes.length} repos`}
                          </span>
                        ) : (
                          <span className="ml-2 text-muted-foreground/60">• global</span>
                        )}
                      </div>
                    </div>
                  </button>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Switch
                      checked={server.enabled}
                      onCheckedChange={() => handleToggle(server)}
                      aria-label={server.enabled ? "Disable" : "Enable"}
                    />
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(server.id)}
                      className="px-2 py-1 text-xs text-destructive hover:text-destructive/80 transition"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Expanded edit form */}
                {isExpanded && (
                  <div className="px-4 pb-4 pt-3 border-t border-border-muted space-y-4">
                    <McpServerForm
                      form={form}
                      setForm={setForm}
                      repos={repos}
                      loadingRepos={loadingRepos}
                      radioPrefix={server.id}
                      showToolVisibility
                      hasExistingCredentials={
                        server.type === form.type && (server.hasEnv || server.hasHeaders)
                      }
                    />
                    {form.type === "remote" && (
                      <RemoteToolVisibility
                        catalog={toolCatalog}
                        selected={form.toolAllowlist}
                        loading={loadingTools}
                        errorMessage={toolError}
                        search={toolSearch}
                        onSearchChange={setToolSearch}
                        onChange={(toolAllowlist) => setForm({ ...form, toolAllowlist })}
                        onRefresh={() => loadRemoteTools(server.id, editor.draftId)}
                      />
                    )}
                    <div className="flex gap-2 pt-2">
                      <Button onClick={save} disabled={saving} size="sm">
                        {saving ? "Saving..." : "Save Changes"}
                      </Button>
                      <Button onClick={cancel} variant="outline" size="sm">
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP server</AlertDialogTitle>
            <AlertDialogDescription>Are you sure? This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && handleDelete(deleteTarget)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
