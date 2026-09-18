"use client";

/**
 * Journey F — the four first-party capability packs (MOS Analytics / MOS
 * CRM / MOS Sheets / MOS Portal) via the first-party-apps routes, plus the
 * Developer Portal (registry catalog + served docs + version history).
 * Surfaces are COMPOSED through the real POST surfaces route and the
 * composition (app + install + surface + composedFrom + model) is rendered
 * verbatim.
 */

import * as React from "react";
import { BookOpen, Boxes, Puzzle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useComposeSurface, useDevAppVersions, useDevCatalog, useDevDocs, useFirstPartyPacks } from "./hooks";
import {
  EmptyState,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  SourceRefList,
  formatWhen,
  shortId,
} from "./shared";

export function AppsPacksSection({
  workspaceId,
  mode,
}: {
  workspaceId: string | null;
  mode: "packs" | "developer";
}) {
  if (mode === "packs") {
    return <FirstPartyPacks workspaceId={workspaceId} />;
  }
  return <DeveloperPortal />;
}

function FirstPartyPacks({ workspaceId }: { workspaceId: string | null }) {
  const packs = useFirstPartyPacks(workspaceId);

  if (workspaceId === null) {
    return (
      <EmptyState
        title="No workspace in scope"
        hint="Pick a client and workspace above — pack state is workspace-scoped."
        icon={Puzzle}
      />
    );
  }
  if (packs.isPending) return <LoadingSkeleton rows={4} />;
  if (packs.isError) {
    return <MosErrorView error={packs.error} what="the first-party packs" onRetry={() => void packs.refetch()} />;
  }
  const list = packs.data ?? [];

  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-muted-foreground">
        source: GET /api/first-party-apps/workspaces/:workspaceId/packs · workspace {shortId(workspaceId)} ·{" "}
        {list.length} pack{list.length === 1 ? "" : "s"} in the registry
      </p>
      {list.length === 0 ? (
        <EmptyState
          title="No first-party packs in the registry"
          hint="The four MKT-051 packs appear once their versions are published to the app registry."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {list.map((pack) => (
            <PackCard key={pack.appKey} pack={pack} workspaceId={workspaceId} />
          ))}
        </div>
      )}
    </div>
  );
}

function PackCard({
  pack,
  workspaceId,
}: {
  pack: import("@/lib/mos-api").FirstPartyPack;
  workspaceId: string;
}) {
  const compose = useComposeSurface(workspaceId);
  const [surface, setSurface] = React.useState(pack.surfaces[0]?.kind ?? "workspace-tab");
  const [documentKey, setDocumentKey] = React.useState("");
  const [composition, setComposition] = React.useState<import("@/lib/mos-api").PackSurfaceComposition | null>(null);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-base">{pack.appKey}</CardTitle>
          <Badge variant="outline" className="font-mono text-xs">
            {pack.family}
          </Badge>
          {pack.currentSelection ? (
            <Badge variant="secondary" className="font-mono text-xs">
              installed v{pack.currentSelection.version}
            </Badge>
          ) : (
            <Badge variant="outline">not installed</Badge>
          )}
        </div>
        <CardDescription>{pack.description}</CardDescription>
      </CardHeader>
      <CardContent className="mt-auto space-y-3">
        <p className="font-mono text-xs text-muted-foreground">
          registry versions: {pack.versions.join(", ") || "—"}
        </p>
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Declared surfaces
          </p>
          <div className="flex flex-wrap gap-1.5">
            {pack.surfaces.map((entry) => (
              <Badge key={entry.kind} variant="secondary" className="font-mono text-[10px]">
                {entry.kind}
              </Badge>
            ))}
          </div>
        </div>

        <div className="space-y-1.5 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            Compose a surface through{" "}
            <span className="font-mono text-[10px]">
              POST /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/surfaces
            </span>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={surface} onValueChange={setSurface}>
              <SelectTrigger className="h-9 font-mono text-xs" aria-label={`Surface for ${pack.appKey}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pack.surfaces.map((entry) => (
                  <SelectItem key={entry.kind} value={entry.kind} className="font-mono text-xs">
                    {entry.kind}
                  </SelectItem>
                ))}
                {pack.surfaces.length === 0 ? (
                  <SelectItem value="workspace-tab" className="font-mono text-xs">
                    workspace-tab
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            <input
              className="h-9 flex-1 rounded-md border bg-transparent px-3 font-mono text-xs"
              placeholder="documentKey (optional)"
              value={documentKey}
              onChange={(event) => setDocumentKey(event.target.value)}
              aria-label={`Document key for ${pack.appKey}`}
            />
            <Button
              size="sm"
              disabled={compose.isPending}
              onClick={() =>
                compose.mutate(
                  {
                    appKey: pack.appKey,
                    surface,
                    ...(documentKey === "" ? {} : { documentKey }),
                  },
                  { onSuccess: (result) => setComposition(result) },
                )
              }
            >
              Compose
            </Button>
          </div>
        </div>

        {composition ? (
          <div className="space-y-1 rounded-lg border bg-muted/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Composition (composed {formatWhen(composition.generatedAt)})
            </p>
            <p className="font-mono text-[10px]">composedFrom:</p>
            <SourceRefList refs={composition.composedFrom} />
            <pre className="mos-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs">
              {JSON.stringify({ app: composition.app, install: composition.install, surface: composition.surface, model: composition.model }, null, 2)}
            </pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DeveloperPortal() {
  const catalog = useDevCatalog();
  const docs = useDevDocs();
  const [appKey, setAppKey] = React.useState<string | null>(null);
  const versions = useDevAppVersions(appKey);
  const apps = catalog.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4" aria-hidden="true" /> Developer catalog
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            source: GET /api/developer-portal/catalog — the /apps registry rollup (no portal-owned
            state)
          </CardDescription>
        </CardHeader>
        <CardContent>
          {catalog.isPending ? (
            <LoadingSkeleton rows={2} />
          ) : catalog.isError ? (
            <MosErrorView error={catalog.error} what="the developer catalog" />
          ) : apps.length === 0 ? (
            <EmptyState
              title="No apps in the registry"
              hint="Publish an app version through POST /api/developer-portal/publish to see it here."
            />
          ) : (
            <div className="space-y-2">
              {apps.map((app) => (
                <button
                  key={app.appKey}
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setAppKey(app.appKey === appKey ? null : app.appKey)}
                  aria-expanded={appKey === app.appKey}
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-sm">{app.appKey}</span>
                    <span className="block text-xs text-muted-foreground">publisher {app.publisher}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="font-mono text-xs">
                      newest v{app.newestVersion}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-xs">
                      {app.versionCount} version{app.versionCount === 1 ? "" : "s"}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-xs">
                      {app.certificationState}
                    </Badge>
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {appKey !== null ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-base">
              <Boxes className="size-4" aria-hidden="true" /> {appKey} — version history
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              source: GET /api/developer-portal/apps/:appKey/versions
            </CardDescription>
          </CardHeader>
          <CardContent>
            {versions.isPending ? (
              <LoadingSkeleton rows={2} />
            ) : versions.isError ? (
              <MosErrorView error={versions.error} what="the app version history" />
            ) : (versions.data ?? []).length === 0 ? (
              <EmptyState title="No versions recorded" />
            ) : (
              <ScrollList label="Versions" className="space-y-1.5">
                {(versions.data ?? []).map((version) => (
                  <div key={version.appVersionId} className="rounded-lg border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="font-mono text-xs">
                        v{version.manifest.version}
                      </Badge>
                      <Badge variant="outline" className="font-mono text-xs">
                        {version.certificationState}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {formatWhen(version.publishedAt)}
                      </span>
                    </div>
                    {version.manifest.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">{version.manifest.description}</p>
                    ) : null}
                    <p className="font-mono text-[10px] text-muted-foreground">
                      appVersionId {version.appVersionId}
                    </p>
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Served documentation</CardTitle>
          <CardDescription className="font-mono text-xs">
            source: GET /api/developer-portal/docs — {docs.data?.generatedFrom ?? "derived at read time"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {docs.isPending ? (
            <LoadingSkeleton rows={2} />
          ) : docs.isError ? (
            <MosErrorView error={docs.error} what="the developer docs" />
          ) : (
            <ScrollList label="Manifest fields" className="space-y-1.5">
              {(docs.data?.manifestFields ?? []).map((field) => (
                <div key={field.field} className="rounded-md border p-2">
                  <p className="font-mono text-xs">
                    {field.field}: <span className="text-muted-foreground">{field.type}</span>
                    {field.required ? <Badge variant="outline" className="ml-2 text-[10px]">required</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">{field.description}</p>
                </div>
              ))}
            </ScrollList>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
