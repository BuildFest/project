-- Planning-agent bootstrap calls made before project-scoped auditing was
-- fixed were stored with project_id = null. When this installation contains
-- exactly one project, that project is unambiguous, so recover those audit
-- rows for its Fails view. Multi-project installations are left untouched.
with sole_project as (
  select min(project_id) as project_id
    from projects
  having count(*) = 1
)
update ai_runs as run
   set project_id = sole_project.project_id
  from sole_project
 where run.project_id is null;
