/**
 * Per-object sharing enforcement for read tools.
 *
 * Every hyobject carries a sharing_type_id (sharing_types: 1=private,
 * 2=workspace, 3=org, 4=public, 5=llm_readable). Within a workspace, only
 * `private` restricts visibility in the OSS server: a private document is
 * readable ONLY by the agent that created it (hyobjects.agent_id), plus
 * service-role callers. Everything else is workspace-visible, as before.
 *
 * The predicate is fixed SQL text — withSession() already publishes the
 * caller's identity as session locals (`app.actor_id`, `app.principal_role`),
 * so no bind-parameter juggling is needed at call sites. Rows with an unknown
 * creator (agent_id IS NULL) that are marked private stay hidden from
 * non-service callers: conservative by design — untraceable private data is
 * not shown to anyone.
 */

/** WHERE-clause fragment: can the current session see this hyobject row? */
export function hyobjectVisibleSql(alias: string): string {
  return (
    `(${alias}.sharing_type_id IS DISTINCT FROM 1` +
    ` OR ${alias}.agent_id = current_setting('app.actor_id', true)` +
    ` OR current_setting('app.principal_role', true) = 'service')`
  );
}
