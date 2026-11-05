CREATE INDEX ix_mcp_servers_user_id ON mcp_servers (user_id);

CREATE INDEX ix_provider_keys_user_id ON provider_keys (user_id);

CREATE INDEX ix_user_roles_user_id ON user_roles (user_id);

CREATE INDEX ix_user_skills_user_id ON user_skills (user_id);

CREATE INDEX ix_user_templates_user_id ON user_templates (user_id);

CREATE INDEX ix_workspaces_user_id ON workspaces (user_id);

CREATE TABLE "workspaces" (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	path VARCHAR(1000) NOT NULL, 
	created_at DATETIME NOT NULL, 
	last_opened_at DATETIME NOT NULL, 
	CONSTRAINT fk_workspaces_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT pk_workspaces PRIMARY KEY (id), 
	CONSTRAINT uq_workspace_path UNIQUE (user_id, path)
);

CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

CREATE TABLE mcp_servers (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	transport VARCHAR(10) NOT NULL, 
	command VARCHAR(300) NOT NULL, 
	args_json JSON NOT NULL, 
	url VARCHAR(500) NOT NULL, 
	env_encrypted TEXT NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	tools_json JSON NOT NULL, 
	last_error TEXT NOT NULL, 
	updated_at DATETIME NOT NULL, 
	CONSTRAINT fk_mcp_servers_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT pk_mcp_servers PRIMARY KEY (id), 
	CONSTRAINT uq_mcp_name UNIQUE (user_id, name)
);

CREATE TABLE provider_keys (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	provider VARCHAR(40) NOT NULL, 
	encrypted_key TEXT NOT NULL, 
	base_url VARCHAR(300) NOT NULL, 
	extra_json JSON NOT NULL, 
	updated_at DATETIME NOT NULL, 
	CONSTRAINT fk_provider_keys_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT pk_provider_keys PRIMARY KEY (id), 
	CONSTRAINT uq_provider_key UNIQUE (user_id, provider)
);

CREATE TABLE user_roles (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	"key" VARCHAR(80) NOT NULL, 
	role VARCHAR(120) NOT NULL, 
	category VARCHAR(40) NOT NULL, 
	description TEXT NOT NULL, 
	system_prompt TEXT NOT NULL, 
	default_name VARCHAR(60) NOT NULL, 
	color VARCHAR(20) NOT NULL, 
	avatar VARCHAR(40) NOT NULL, 
	tools_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	CONSTRAINT fk_user_roles_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT pk_user_roles PRIMARY KEY (id), 
	CONSTRAINT uq_user_role_key UNIQUE (user_id, "key")
);

CREATE TABLE user_skills (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	name VARCHAR(64) NOT NULL, 
	description TEXT NOT NULL, 
	roles TEXT NOT NULL, 
	phases TEXT NOT NULL, 
	body TEXT NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	CONSTRAINT fk_user_skills_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT pk_user_skills PRIMARY KEY (id), 
	CONSTRAINT uq_user_skill_name UNIQUE (user_id, name)
);

CREATE TABLE user_templates (
	id VARCHAR(36) NOT NULL, 
	user_id VARCHAR(36) NOT NULL, 
	name VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	spec_json JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	CONSTRAINT fk_user_templates_user_id_users FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	CONSTRAINT pk_user_templates PRIMARY KEY (id)
);

CREATE TABLE users (
	id VARCHAR(36) NOT NULL, 
	email VARCHAR(255) NOT NULL, 
	password_hash VARCHAR(255) NOT NULL, 
	created_at DATETIME NOT NULL, approval_mode VARCHAR(10) DEFAULT 'ask' NOT NULL, 
	CONSTRAINT pk_users PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_users_email ON users (email);
