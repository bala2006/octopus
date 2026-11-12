/** The catalog: team templates, the role library and skills, each built in and editable. */
import { RoleInSchema, SkillInSchema, UserTemplateInSchema, type CanvasExport } from "@octopus/shared";
import type { Registry } from "../../db/registry";
import { effectiveRoles, BUILTIN_ROLES } from "../../catalog/roles";
import { BUILTIN_SKILLS, effectiveSkills } from "../../catalog/skills";
import { buildTemplate, templateList } from "../../catalog/templates";
import { newId, notFound, now, slug, UserError } from "../../lib/util";
import type { RouteFn } from "../router";

export function templateSpec(reg: Registry, key: string): CanvasExport {
  const user = reg.templates.get(key);
  if (user) return user.spec;
  const t = templateList(reg).find((x) => x.key === key);
  if (!t) throw notFound("Template");
  const built = buildTemplate(reg, key, "template");
  return { format: "octopus.company/v1", name: t.name, description: t.description, agents: built.agents, edges: built.edges, departments: built.departments };
}

export function saveUserTemplate(reg: Registry, name: string, description: string, spec: CanvasExport) {
  const key = `user:${slug(name)}-${newId().slice(0, 4)}`;
  reg.templates.insert({ key, name, description, spec: { ...spec, name }, updated_at: now() });
  return templateList(reg).find((t) => t.key === key)!;
}

export function catalogRoutes(route: RouteFn, reg: Registry) {
  route("GET", "/api/v1/templates", () => templateList(reg));
  route("GET", "/api/v1/templates/roles", () => effectiveRoles(reg));
  route("GET", "/api/v1/templates/{key}/spec", ({ params }) => templateSpec(reg, params.key));
  route("POST", "/api/v1/templates", UserTemplateInSchema, ({ body }) => {
    if (!body.spec) throw new UserError("Give the team spec to save");
    return saveUserTemplate(reg, body.name, body.description ?? "", body.spec);
  });
  route("PATCH", "/api/v1/templates/{key}", UserTemplateInSchema, ({ params, body }) => {
    const t = reg.templates.get(params.key);
    if (!t) throw new UserError("Built-in templates cannot be changed; save a copy instead", 400);
    reg.templates.update(t.key, { name: body.name, description: body.description ?? t.description, spec: body.spec ?? t.spec, updated_at: now() });
    return templateList(reg).find((x) => x.key === t.key)!;
  });
  route("DELETE", "/api/v1/templates/{key}", ({ params }) => { reg.templates.remove(params.key); return { ok: true }; });

  route("GET", "/api/v1/roles", () => effectiveRoles(reg));
  route("POST", "/api/v1/roles", RoleInSchema, ({ body }) => {
    const key = slug(body.role).replace(/-/g, "_");
    if (effectiveRoles(reg).some((r) => r.key === key)) throw new UserError(`A role called ${body.role} already exists`, 409);
    reg.roles.upsert({ key, deleted: false, updated_at: now(), data: { key, role: body.role, system_prompt: body.system_prompt, description: body.description ?? "",
      default_name: body.default_name ?? "", category: body.category ?? "Custom", color: body.color ?? "#66839A", avatar: body.avatar ?? "bot", tools: body.tools ?? {} } });
    return effectiveRoles(reg).find((r) => r.key === key)!;
  });
  route("PUT", "/api/v1/roles/{key}", RoleInSchema, ({ params, body }) => {
    const base = effectiveRoles(reg).find((r) => r.key === params.key);
    if (!base) throw notFound("Role");
    reg.roles.upsert({ key: params.key, deleted: false, updated_at: now(), data: { ...base, ...body, tools: body.tools ?? base.tools, key: params.key,
      default_name: body.default_name ?? base.default_name, category: body.category ?? base.category, color: body.color ?? base.color, avatar: body.avatar ?? base.avatar,
      description: body.description ?? base.description } });
    return effectiveRoles(reg).find((r) => r.key === params.key)!;
  });
  route("DELETE", "/api/v1/roles/{key}", ({ params }) => {
    if (params.key === "orchestrator") throw new UserError("The orchestrator role is needed to run the company");
    const builtin = BUILTIN_ROLES.find((r) => r.key === params.key);
    if (builtin) reg.roles.upsert({ key: params.key, deleted: true, updated_at: now(), data: builtin });
    else reg.roles.remove(params.key);
    return { ok: true };
  });
  route("POST", "/api/v1/roles/restore-defaults", () => { reg.roles.removeWhere("1=1"); return { ok: true }; });

  route("GET", "/api/v1/skills", () => effectiveSkills(reg));
  const saveSkill = (name: string, body: ReturnType<typeof SkillInSchema.parse>) => {
    reg.skills.upsert({ name, deleted: false, updated_at: now(), data: { name, description: body.description, body: body.body, roles: body.roles ?? [], phases: body.phases ?? [] } });
    return effectiveSkills(reg).find((s) => s.name === name)!;
  };
  route("POST", "/api/v1/skills", SkillInSchema, ({ body }) => {
    if (effectiveSkills(reg).some((s) => s.name === body.name)) throw new UserError(`A skill called ${body.name} already exists`, 409);
    return saveSkill(body.name, body);
  });
  route("PUT", "/api/v1/skills/{name}", SkillInSchema, ({ params, body }) => saveSkill(params.name, body));
  route("DELETE", "/api/v1/skills/{name}", ({ params }) => {
    const builtin = BUILTIN_SKILLS.find((s) => s.name === params.name);
    if (builtin) reg.skills.upsert({ name: params.name, deleted: true, updated_at: now(), data: builtin });
    else reg.skills.remove(params.name);
    return { ok: true };
  });
  route("POST", "/api/v1/skills/restore-defaults", () => { reg.skills.removeWhere("1=1"); return { ok: true }; });
}
