"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EyeIcon, EyeOffIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { normalizeKey, parseMaybeEnvContent, type ParsedEnvEntry } from "@/lib/env-paste";

const VALID_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 256;
const MAX_VALUE_SIZE = 16384;
const MAX_TOTAL_VALUE_SIZE = 65536;
const MAX_SECRETS_PER_SCOPE = 50;

const RESERVED_KEYS = new Set([
  "PYTHONUNBUFFERED",
  "SANDBOX_ID",
  "CONTROL_PLANE_URL",
  "SANDBOX_AUTH_TOKEN",
  "REPO_OWNER",
  "REPO_NAME",
  "GITHUB_APP_TOKEN",
  "SESSION_CONFIG",
  "RESTORED_FROM_SNAPSHOT",
  "OPENCODE_CONFIG_CONTENT",
  "ANTHROPIC_OAUTH_ENABLED",
  "ANTHROPIC_OAUTH_AUTHORIZE_URL",
  "ANTHROPIC_OAUTH_CLIENT_ID",
  "ANTHROPIC_OAUTH_TOKEN_URL",
  "ANTHROPIC_OAUTH_REDIRECT_URI",
  "ANTHROPIC_OAUTH_SCOPES",
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "LANG",
]);

type SecretRow = {
  id: string;
  key: string;
  value: string;
  existing: boolean;
  dirty: boolean;
  decryptionFailed: boolean;
};

type SecretMeta = {
  key: string;
  value: string | null;
  createdAt: number;
  updatedAt: number;
  decryptionFailed?: boolean;
};

interface SecretsResponse {
  secrets: SecretMeta[];
  globalSecrets?: SecretMeta[];
}

function validateKey(value: string): string | null {
  if (!value) return "Key is required";
  if (value.length > MAX_KEY_LENGTH) return "Key is too long";
  if (!VALID_KEY_PATTERN.test(value)) return "Key must match [A-Za-z_][A-Za-z0-9_]*";
  if (RESERVED_KEYS.has(value.toUpperCase())) return `Key '${value}' is reserved`;
  return null;
}

function getUtf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

function createRow(partial?: Partial<SecretRow>): SecretRow {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return {
    id,
    key: "",
    value: "",
    existing: false,
    dirty: false,
    decryptionFailed: false,
    ...partial,
  };
}

function SecretValueField({
  value,
  revealed,
  onToggleReveal,
  onChange,
  onPaste,
  disabled,
  readOnly,
  placeholder,
  label,
}: {
  value: string;
  revealed: boolean;
  onToggleReveal: () => void;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder: string;
  label: string;
}) {
  const title = revealed ? "Hide value" : "Show value";

  return (
    <div className="flex flex-1 min-w-[200px] items-center gap-1">
      <Input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        onPaste={onPaste}
        aria-label={label}
        className="min-w-0 flex-1 h-auto px-2 py-1 text-xs font-mono"
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleReveal}
            disabled={disabled}
            aria-label={title}
            title={title}
            className="h-7 w-7 flex-shrink-0"
          >
            {revealed ? (
              <EyeOffIcon className="w-3.5 h-3.5" />
            ) : (
              <EyeIcon className="w-3.5 h-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function SecretsEditor({
  owner,
  name,
  disabled = false,
  scope = "repo",
}: {
  owner?: string;
  name?: string;
  disabled?: boolean;
  scope?: "repo" | "global";
}) {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [revealedRowIds, setRevealedRowIds] = useState<Set<string>>(() => new Set());
  const [revealedGlobalKeys, setRevealedGlobalKeys] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const isGlobal = scope === "global";
  const ready = isGlobal || Boolean(owner && name);
  const repoLabel = owner && name ? `${owner}/${name}` : "";

  const apiBase = isGlobal ? "/api/secrets" : `/api/repos/${owner}/${name}/secrets`;

  const {
    data: secretsData,
    isLoading: loading,
    error: fetchError,
  } = useSWR<SecretsResponse>(ready ? apiBase : null);

  // Sync SWR data into local editable rows
  const secrets = secretsData?.secrets;
  useEffect(() => {
    if (!Array.isArray(secrets)) {
      setRows([]);
      setRevealedRowIds(new Set());
      return;
    }
    setRows(
      secrets.map((secret) =>
        createRow({
          key: secret.key,
          value: secret.value ?? "",
          existing: true,
          decryptionFailed: secret.decryptionFailed === true,
        })
      )
    );
    setRevealedRowIds(new Set());
  }, [secrets]);

  // Show fetch errors to the user
  useEffect(() => {
    if (fetchError) {
      setError("Failed to load secrets");
    }
  }, [fetchError]);

  const globalRows: SecretMeta[] =
    !isGlobal && Array.isArray(secretsData?.globalSecrets) ? secretsData.globalSecrets : [];

  useEffect(() => {
    setRevealedGlobalKeys(new Set());
  }, [secretsData?.globalSecrets]);

  const existingKeySet = useMemo(() => {
    return new Set(rows.filter((row) => row.existing).map((row) => normalizeKey(row.key)));
  }, [rows]);

  const applyEnvEntries = useCallback((entries: ParsedEnvEntry[]) => {
    setRows((current) => {
      const next = [...current];
      const keyToIndex = new Map<string, number>();

      next.forEach((row, index) => {
        const normalized = normalizeKey(row.key);
        if (normalized) {
          keyToIndex.set(normalized, index);
        }
      });

      for (const entry of entries) {
        const normalizedKey = normalizeKey(entry.key);
        const existingIndex = keyToIndex.get(normalizedKey);

        if (existingIndex !== undefined) {
          next[existingIndex] = {
            ...next[existingIndex],
            key: normalizedKey,
            value: entry.value,
            dirty: true,
            decryptionFailed: false,
          };
          continue;
        }

        const emptyRowIndex = next.findIndex(
          (row) => !row.existing && row.key.trim() === "" && row.value.trim() === ""
        );

        if (emptyRowIndex >= 0) {
          next[emptyRowIndex] = {
            ...next[emptyRowIndex],
            key: normalizedKey,
            value: entry.value,
            dirty: true,
          };
          keyToIndex.set(normalizedKey, emptyRowIndex);
          continue;
        }

        next.push(createRow({ key: normalizedKey, value: entry.value, dirty: true }));
        keyToIndex.set(normalizedKey, next.length - 1);
      }

      return next;
    });
  }, []);

  const toggleRowReveal = useCallback((rowId: string) => {
    setRevealedRowIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const toggleGlobalReveal = useCallback((key: string) => {
    const normalizedKey = normalizeKey(key);
    setRevealedGlobalKeys((current) => {
      const next = new Set(current);
      if (next.has(normalizedKey)) {
        next.delete(normalizedKey);
      } else {
        next.add(normalizedKey);
      }
      return next;
    });
  }, []);

  const handlePasteIntoRow = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      const pastedText = event.clipboardData.getData("text");
      const parsed = parseMaybeEnvContent(pastedText);
      if (parsed.length === 0) {
        return;
      }

      const valid = parsed.filter((entry) => !RESERVED_KEYS.has(entry.key));
      const skipped = parsed.length - valid.length;

      if (valid.length === 0 && skipped > 0) {
        event.preventDefault();
        setError(`All ${skipped} pasted key${skipped === 1 ? " is" : "s are"} reserved`);
        return;
      }

      event.preventDefault();
      applyEnvEntries(valid);
      setError("");

      const imported = `Imported ${valid.length} secret${valid.length === 1 ? "" : "s"} from paste`;
      const skippedMsg = skipped > 0 ? ` (skipped ${skipped} reserved)` : "";
      toast.success(imported + skippedMsg);
    },
    [applyEnvEntries]
  );

  const handleAddRow = () => {
    setRows((current) => [...current, createRow()]);
  };

  const handleDeleteRow = async (row: SecretRow) => {
    if (!ready) return;

    if (!row.existing || !row.key) {
      setRows((current) => current.filter((item) => item.id !== row.id));
      setRevealedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      return;
    }

    const normalizedKey = normalizeKey(row.key);
    setDeletingKey(normalizedKey);
    setError("");

    try {
      const response = await fetch(`${apiBase}/${normalizedKey}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data?.error || "Failed to delete secret");
        return;
      }
      toast.success(`Deleted ${normalizedKey}`);
      mutate(apiBase);
    } catch {
      toast.error("Failed to delete secret");
    } finally {
      setDeletingKey(null);
    }
  };

  const handleSave = async () => {
    if (!ready) return;

    setError("");

    const enteredRows = rows.filter(
      (row) => row.key.trim().length > 0 || row.value.trim().length > 0
    );

    if (enteredRows.length === 0) {
      toast("No changes to save");
      return;
    }

    const uniqueKeys = new Set<string>();

    for (const row of enteredRows) {
      const key = normalizeKey(row.key);
      const keyError = validateKey(key);
      if (keyError) {
        setError(keyError);
        return;
      }
      if (uniqueKeys.has(key)) {
        setError(`Duplicate key '${key}'`);
        return;
      }
      uniqueKeys.add(key);

      if (!row.existing && row.value.trim().length === 0) {
        setError("Enter a value for new secrets or remove the empty row");
        return;
      }

      const valueSize = getUtf8Size(row.value);
      if (valueSize > MAX_VALUE_SIZE) {
        setError(`Value for '${key}' exceeds ${MAX_VALUE_SIZE} bytes`);
        return;
      }
    }

    const netNew = enteredRows.filter((row) => !existingKeySet.has(normalizeKey(row.key))).length;
    if (existingKeySet.size + netNew > MAX_SECRETS_PER_SCOPE) {
      setError(`Would exceed ${MAX_SECRETS_PER_SCOPE} secrets limit`);
      return;
    }

    const changedEntries = enteredRows
      .filter((row) => !row.existing || row.dirty)
      .map((row) => ({
        key: normalizeKey(row.key),
        value: row.value,
      }));

    if (changedEntries.length === 0) {
      toast("No changes to save");
      return;
    }

    const totalSize = changedEntries.reduce((sum, entry) => sum + getUtf8Size(entry.value), 0);
    if (totalSize > MAX_TOTAL_VALUE_SIZE) {
      setError(`Total secret size exceeds ${MAX_TOTAL_VALUE_SIZE} bytes`);
      return;
    }

    setSaving(true);

    try {
      const payload: Record<string, string> = {};
      for (const entry of changedEntries) {
        payload[entry.key] = entry.value;
      }

      const response = await fetch(apiBase, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: payload }),
      });
      const data = await response.json();

      if (!response.ok) {
        toast.error(data?.error || "Failed to update secrets");
        return;
      }

      toast.success("Secrets updated");
      mutate(apiBase);
    } catch {
      toast.error("Failed to update secrets");
    } finally {
      setSaving(false);
    }
  };

  const descriptionText = isGlobal
    ? "Secrets apply to all repositories. Values are masked by default."
    : `Secrets apply to ${repoLabel || "the selected repo"}. Values are masked by default.`;

  return (
    <TooltipProvider>
      <div className="mt-4 rounded-md border border-border bg-background p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Secrets</h3>
            <p className="text-xs text-muted-foreground">{descriptionText}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleAddRow}
            disabled={!ready || disabled}
          >
            Add secret
          </Button>
        </div>

        {!ready && (
          <p className="text-xs text-muted-foreground">Select a repository to manage secrets.</p>
        )}

        {ready && (
          <>
            {loading && <p className="text-xs text-muted-foreground">Loading secrets...</p>}

            {!loading && rows.length === 0 && globalRows.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {isGlobal ? "No global secrets set." : "No secrets set for this repo."}
              </p>
            )}

            <div className="space-y-2">
              {rows.map((row) => (
                <div key={row.id} className="flex flex-col gap-2 border border-border-muted p-2">
                  <div className="flex flex-wrap gap-2">
                    <Input
                      type="text"
                      value={row.key}
                      onChange={(e) => {
                        const keyValue = e.target.value;
                        setRows((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, key: keyValue } : item
                          )
                        );
                      }}
                      onBlur={(e) => {
                        const normalized = normalizeKey(e.target.value);
                        setRows((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, key: normalized } : item
                          )
                        );
                      }}
                      placeholder="KEY_NAME"
                      disabled={disabled || row.existing}
                      onPaste={handlePasteIntoRow}
                      className="flex-1 min-w-[160px] h-auto px-2 py-1 text-xs"
                    />
                    <SecretValueField
                      value={row.value}
                      revealed={revealedRowIds.has(row.id)}
                      onToggleReveal={() => toggleRowReveal(row.id)}
                      onChange={(e) => {
                        const val = e.target.value;
                        setRows((current) =>
                          current.map((item) =>
                            item.id === row.id
                              ? { ...item, value: val, dirty: true, decryptionFailed: false }
                              : item
                          )
                        );
                      }}
                      placeholder={row.existing ? "••••••••" : "value"}
                      disabled={disabled}
                      onPaste={handlePasteIntoRow}
                      label={`Value for ${row.key || "new secret"}`}
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      onClick={() => handleDeleteRow(row)}
                      disabled={disabled || deletingKey === normalizeKey(row.key)}
                    >
                      {deletingKey === normalizeKey(row.key) ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                  {row.existing && (
                    <p className="text-xs text-muted-foreground">
                      {row.decryptionFailed
                        ? "Value could not be decrypted. Enter a new value and save."
                        : "Edit the value and save to update."}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* Inherited global secrets (repo scope only) */}
            {!isGlobal && globalRows.length > 0 && (
              <div className="mt-4">
                <p className="text-xs text-muted-foreground mb-2">Inherited from global scope</p>
                <div className="space-y-2">
                  {globalRows.map((g) => {
                    const normalizedKey = normalizeKey(g.key);
                    const overridden = existingKeySet.has(normalizedKey);
                    return (
                      <div
                        key={g.key}
                        className={`flex flex-wrap items-center gap-2 border border-border-muted p-2 ${
                          overridden ? "opacity-40" : "opacity-70"
                        }`}
                      >
                        <Badge variant="info">Global</Badge>
                        <span className="text-xs text-foreground font-mono">{g.key}</span>
                        <SecretValueField
                          value={g.value ?? ""}
                          revealed={revealedGlobalKeys.has(normalizedKey)}
                          onToggleReveal={() => toggleGlobalReveal(g.key)}
                          placeholder="••••••••"
                          disabled={disabled}
                          readOnly
                          label={`Inherited global value for ${g.key}`}
                        />
                        {overridden && (
                          <span className="text-xs text-muted-foreground">
                            (overridden by repo)
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

            <div className="mt-3 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={handleSave}
                disabled={disabled || saving || !ready}
              >
                {saving ? "Saving..." : "Save secrets"}
              </Button>
              <span className="text-xs text-muted-foreground">
                Keys are automatically uppercased. Paste a `.env` block into either field to import.
              </span>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
