CREATE INDEX ix_agent_memory_agent_id ON agent_memory (agent_id);

CREATE INDEX ix_agents_company_id ON agents (company_id);

CREATE INDEX ix_artifacts_run_id ON artifacts (run_id);

CREATE INDEX ix_companies_user_id ON companies (user_id);

CREATE INDEX ix_consultations_run_id ON consultations (run_id);

CREATE INDEX ix_edges_company_id ON edges (company_id);

CREATE INDEX ix_execution_evidence_run_id ON execution_evidence (run_id);

CREATE INDEX ix_memory_groups_company_id ON memory_groups (company_id);

CREATE INDEX ix_memory_heads_company_id ON memory_heads (company_id);

CREATE INDEX ix_memory_records_company_id ON memory_records (company_id);

CREATE INDEX ix_memory_records_head_id ON memory_records (head_id);

CREATE INDEX ix_messages_created_at ON messages (created_at);

CREATE INDEX ix_messages_run_id ON messages (run_id);

CREATE INDEX ix_messages_session_id ON messages (session_id);

CREATE INDEX ix_run_events_run_id ON run_events (run_id);

CREATE INDEX ix_run_requests_run_id ON run_requests (run_id);

CREATE INDEX ix_run_requests_state ON run_requests (state);

CREATE INDEX ix_runs_company_id ON runs (company_id);

CREATE INDEX ix_sessions_company_id ON sessions (company_id);

CREATE INDEX ix_task_attempts_run_id ON task_attempts (run_id);

CREATE INDEX ix_tasks_run_id ON tasks (run_id);

CREATE TABLE "agents" (
	id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	role VARCHAR(120) NOT NULL, 
	description TEXT NOT NULL, 
	avatar VARCHAR(64) NOT NULL, 
	color VARCHAR(16) NOT NULL, 
	system_prompt TEXT NOT NULL, 
	provider VARCHAR(40) NOT NULL, 
	model VARCHAR(120) NOT NULL, 
	temperature FLOAT NOT NULL, 
	max_tokens INTEGER NOT NULL, 
	tools_json JSON NOT NULL, 
	behavior_json JSON NOT NULL, 
	is_entry BOOLEAN NOT NULL, 
	position_x FLOAT NOT NULL, 
	position_y FLOAT NOT NULL, 
	department VARCHAR(80) DEFAULT ('') NOT NULL, 
	is_manager BOOLEAN DEFAULT 0 NOT NULL, 
	reports_to VARCHAR(36), 
	active BOOLEAN DEFAULT 1 NOT NULL, 
	created_by VARCHAR(36), 
	CONSTRAINT fk_agents_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT pk_agents PRIMARY KEY (id)
);

CREATE TABLE "artifacts" (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	path VARCHAR(500) NOT NULL, 
	content TEXT NOT NULL, 
	previous_content TEXT, 
	version INTEGER NOT NULL, 
	author_agent_id VARCHAR(36), 
	change_note TEXT NOT NULL, 
	created_at DATETIME NOT NULL, 
	deleted BOOLEAN DEFAULT 0 NOT NULL, 
	CONSTRAINT fk_artifacts_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_artifacts PRIMARY KEY (id), 
	CONSTRAINT uq_artifact_version UNIQUE (run_id, path, version)
);

CREATE TABLE agent_memory (
	id VARCHAR(36) NOT NULL, 
	agent_id VARCHAR(36) NOT NULL, 
	"key" VARCHAR(200) NOT NULL, 
	value TEXT NOT NULL, 
	updated_at DATETIME NOT NULL, 
	CONSTRAINT fk_agent_memory_agent_id_agents FOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE, 
	CONSTRAINT pk_agent_memory PRIMARY KEY (id), 
	CONSTRAINT uq_memory_key UNIQUE (agent_id, "key")
);

CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

CREATE TABLE companies (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	canvas_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, revision INTEGER DEFAULT '0' NOT NULL, 
	CONSTRAINT pk_companies PRIMARY KEY (id)
);

CREATE TABLE consultations (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	revision INTEGER NOT NULL, 
	sender VARCHAR(36) NOT NULL, 
	recipient VARCHAR(36) NOT NULL, 
	question TEXT NOT NULL, 
	answer TEXT NOT NULL, 
	state VARCHAR(20) NOT NULL, 
	deadline DATETIME NOT NULL, 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_consultations_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_consultations PRIMARY KEY (id)
);

CREATE TABLE edges (
	id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	source_agent_id VARCHAR(36) NOT NULL, 
	target_agent_id VARCHAR(36) NOT NULL, 
	bidirectional BOOLEAN NOT NULL, 
	type VARCHAR(20) NOT NULL, 
	label VARCHAR(200) NOT NULL, 
	config_json JSON NOT NULL, 
	CONSTRAINT fk_edges_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT fk_edges_source_agent_id_agents FOREIGN KEY(source_agent_id) REFERENCES agents (id) ON DELETE CASCADE, 
	CONSTRAINT fk_edges_target_agent_id_agents FOREIGN KEY(target_agent_id) REFERENCES agents (id) ON DELETE CASCADE, 
	CONSTRAINT pk_edges PRIMARY KEY (id)
);

CREATE TABLE execution_evidence (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	attempt_id VARCHAR(36) NOT NULL, 
	revision INTEGER NOT NULL, 
	record_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_execution_evidence_attempt_id_task_attempts FOREIGN KEY(attempt_id) REFERENCES task_attempts (id) ON DELETE CASCADE, 
	CONSTRAINT fk_execution_evidence_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_execution_evidence PRIMARY KEY (id)
);

CREATE TABLE memory_group_members (
	group_id VARCHAR(36) NOT NULL, 
	agent_id VARCHAR(36) NOT NULL, 
	CONSTRAINT fk_memory_group_members_agent_id_agents FOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE CASCADE, 
	CONSTRAINT fk_memory_group_members_group_id_memory_groups FOREIGN KEY(group_id) REFERENCES memory_groups (id) ON DELETE CASCADE, 
	CONSTRAINT pk_memory_group_members PRIMARY KEY (group_id, agent_id)
);

CREATE TABLE memory_groups (
	id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	active BOOLEAN DEFAULT 1 NOT NULL, 
	CONSTRAINT fk_memory_groups_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT pk_memory_groups PRIMARY KEY (id)
);

CREATE TABLE memory_heads (
	id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	scope VARCHAR(16) NOT NULL, 
	scope_id VARCHAR(36) NOT NULL, 
	"key" VARCHAR(200) NOT NULL, 
	version INTEGER NOT NULL, 
	CONSTRAINT fk_memory_heads_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT pk_memory_heads PRIMARY KEY (id), 
	CONSTRAINT uq_memory_head_scope UNIQUE (company_id, scope, scope_id, "key")
);

CREATE TABLE memory_records (
	id VARCHAR(36) NOT NULL, 
	head_id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36), 
	version INTEGER NOT NULL, 
	content TEXT NOT NULL, 
	classification VARCHAR(16) NOT NULL, 
	source_refs JSON NOT NULL, 
	author_agent_id VARCHAR(36), 
	pinned BOOLEAN NOT NULL, 
	import_key VARCHAR(200), 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_memory_records_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT fk_memory_records_head_id_memory_heads FOREIGN KEY(head_id) REFERENCES memory_heads (id) ON DELETE CASCADE, 
	CONSTRAINT fk_memory_records_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE SET NULL, 
	CONSTRAINT pk_memory_records PRIMARY KEY (id), 
	CONSTRAINT uq_memory_records_import_key UNIQUE (import_key), 
	CONSTRAINT uq_scoped_memory_version UNIQUE (head_id, version)
);

CREATE TABLE messages (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36), 
	session_id VARCHAR(36), 
	sender VARCHAR(10) NOT NULL, 
	from_agent_id VARCHAR(36), 
	to_agent_id VARCHAR(36), 
	edge_id VARCHAR(36), 
	type VARCHAR(30) NOT NULL, 
	content TEXT NOT NULL, 
	meta_json JSON NOT NULL, 
	turn_no INTEGER NOT NULL, 
	read BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_messages_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT fk_messages_session_id_sessions FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE CASCADE, 
	CONSTRAINT pk_messages PRIMARY KEY (id)
);

CREATE TABLE run_events (
	id INTEGER NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	type VARCHAR(40) NOT NULL, 
	payload_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_run_events_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_run_events PRIMARY KEY (id)
);

CREATE TABLE run_requests (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	client_id VARCHAR(100) NOT NULL, 
	kind VARCHAR(20) NOT NULL, 
	content TEXT NOT NULL, 
	content_hash VARCHAR(64) NOT NULL, 
	target VARCHAR(36) NOT NULL, 
	attachments_json JSON NOT NULL, 
	revision INTEGER NOT NULL, 
	state VARCHAR(24) NOT NULL, 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_run_requests_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_run_requests PRIMARY KEY (id), 
	CONSTRAINT uq_request_client UNIQUE (run_id, client_id)
);

CREATE TABLE runs (
	id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	session_id VARCHAR(36), 
	goal TEXT NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	mode VARCHAR(20) NOT NULL, 
	permission_level VARCHAR(20) NOT NULL, 
	budget_json JSON NOT NULL, 
	snapshot_json JSON NOT NULL, 
	state_json JSON NOT NULL, 
	tokens_used INTEGER NOT NULL, 
	cost_usd FLOAT NOT NULL, 
	turns INTEGER NOT NULL, 
	halt_reason VARCHAR(200) NOT NULL, 
	summary TEXT NOT NULL, 
	created_at DATETIME NOT NULL, 
	started_at DATETIME, 
	ended_at DATETIME, 
	report_md TEXT NOT NULL, 
	CONSTRAINT fk_runs_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT fk_runs_session_id_sessions FOREIGN KEY(session_id) REFERENCES sessions (id) ON DELETE SET NULL, 
	CONSTRAINT pk_runs PRIMARY KEY (id)
);

CREATE TABLE sessions (
	id VARCHAR(36) NOT NULL, 
	company_id VARCHAR(36) NOT NULL, 
	agent_id VARCHAR(36), 
	title VARCHAR(200) NOT NULL, 
	mode VARCHAR(20) NOT NULL, 
	created_at DATETIME NOT NULL, 
	CONSTRAINT fk_sessions_agent_id_agents FOREIGN KEY(agent_id) REFERENCES agents (id) ON DELETE SET NULL, 
	CONSTRAINT fk_sessions_company_id_companies FOREIGN KEY(company_id) REFERENCES companies (id) ON DELETE CASCADE, 
	CONSTRAINT pk_sessions PRIMARY KEY (id)
);

CREATE TABLE task_attempts (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	agent_id VARCHAR(36) NOT NULL, 
	revision INTEGER NOT NULL, 
	state VARCHAR(24) NOT NULL, 
	assignment_json JSON NOT NULL, 
	result_json JSON NOT NULL, 
	session_id VARCHAR(200), 
	started_at DATETIME NOT NULL, 
	ended_at DATETIME, 
	CONSTRAINT fk_task_attempts_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_task_attempts PRIMARY KEY (id)
);

CREATE TABLE tasks (
	id VARCHAR(36) NOT NULL, 
	run_id VARCHAR(36) NOT NULL, 
	"key" VARCHAR(20) NOT NULL, 
	title VARCHAR(300) NOT NULL, 
	description TEXT NOT NULL, 
	assignee_agent_id VARCHAR(36), 
	status VARCHAR(20) NOT NULL, 
	acceptance_criteria TEXT NOT NULL, 
	created_by VARCHAR(36), 
	updated_at DATETIME NOT NULL, constraints_json JSON DEFAULT '{}' NOT NULL, 
	CONSTRAINT fk_tasks_run_id_runs FOREIGN KEY(run_id) REFERENCES runs (id) ON DELETE CASCADE, 
	CONSTRAINT pk_tasks PRIMARY KEY (id)
);
