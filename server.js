const express = require("express");
const path = require("path");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// CONFIGURAÇÃO
// =====================================================

const pastaPublica = path.join(__dirname, "public");
const caminhoBanco = path.join(__dirname, "sistema.db");

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(pastaPublica));

console.log("=================================");
console.log("ARQUIVO SERVER.JS EXECUTADO:");
console.log(__filename);
console.log("PASTA DO SERVER:");
console.log(__dirname);
console.log("=================================");
console.log("Pasta pública:", pastaPublica);

const usandoPostgres = !!process.env.DATABASE_URL;

console.log(
    "Banco utilizado:",
    usandoPostgres ? "PostgreSQL" : "SQLite local"
);

if (!usandoPostgres) {
    console.log("Banco local:", caminhoBanco);
}

// =====================================================
// BANCO POSTGRESQL
// =====================================================

let pool = null;

if (usandoPostgres) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.on("connect", () => {
        console.log("Conexão com PostgreSQL estabelecida.");
    });

    pool.on("error", (erro) => {
        console.error("Erro inesperado no PostgreSQL:", erro);
    });
}

// =====================================================
// COMPATIBILIDADE DE SQL
// =====================================================

function converterParametros(sql, parametros = []) {
    let indice = 0;

    const novoSql = sql.replace(/\?/g, () => {
        indice++;
        return `$${indice}`;
    });

    return {
        sql: novoSql,
        parametros
    };
}

function adaptarSqlPostgres(sql) {
    let novoSql = sql;

    // ==========================================
    // POSTGRESQL
    // ==========================================

    if (usandoPostgres) {

        novoSql = novoSql.replace(
            /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi,
            "SERIAL PRIMARY KEY"
        );

        novoSql = novoSql.replace(
            /\bDATETIME\b/gi,
            "TIMESTAMP"
        );

        novoSql = novoSql.replace(
            /INSERT\s+OR\s+IGNORE/gi,
            "INSERT"
        );

        return novoSql;
    }

    // ==========================================
    // SQLITE LOCAL
    // ==========================================

    novoSql = novoSql.replace(
        /SERIAL\s+PRIMARY\s+KEY/gi,
        "INTEGER PRIMARY KEY AUTOINCREMENT"
    );

    novoSql = novoSql.replace(
        /\bTIMESTAMP\b/gi,
        "DATETIME"
    );

    return novoSql;
}
// =====================================================
// BANCO COMPATÍVEL
// =====================================================

const db = {

    run(sql, parametros = [], callback = () => {}) {

        if (!usandoPostgres) {
            const sqlite3 = require("sqlite3").verbose();

            if (!this._sqlite) {
                this._sqlite = new sqlite3.Database(caminhoBanco);
            }

            return this._sqlite.run(
                sql,
                parametros,
                function (erro) {
                    callback.call(this, erro);
                }
            );
        }

        const sqlOriginal = sql.trim();

        if (/^PRAGMA\s+table_info/i.test(sqlOriginal)) {
            const tabela = sqlOriginal.match(
                /PRAGMA\s+table_info\(([^)]+)\)/i
            );

            if (!tabela) {
                callback.call(
                    { lastID: 0, changes: 0 },
                    new Error("PRAGMA inválido.")
                );
                return;
            }

            const nomeTabela = tabela[1].replace(/["'`]/g, "");

            pool.query(
                `
                SELECT
                    column_name AS name,
                    data_type,
                    is_nullable
                FROM information_schema.columns
                WHERE table_schema = 'public'
                AND table_name = $1
                ORDER BY ordinal_position
                `,
                [nomeTabela.toLowerCase()]
            )
            .then(resultado => {
                callback.call(
                    {
                        lastID: 0,
                        changes: resultado.rowCount
                    },
                    null
                );
            })
            .catch(erro => {
                callback.call(
                    {
                        lastID: 0,
                        changes: 0
                    },
                    erro
                );
            });

            return;
        }

        let sqlAdaptado = adaptarSqlPostgres(sqlOriginal);

        const convertido = converterParametros(
            sqlAdaptado,
            parametros
        );

        const ehInsert = /^INSERT\s/i.test(sqlOriginal);

        if (ehInsert && !/RETURNING\s/i.test(sqlAdaptado)) {
            sqlAdaptado += " RETURNING id";
        }

        pool.query(
            sqlAdaptado,
            convertido.parametros
        )
        .then(resultado => {

            const primeiro = resultado.rows[0];

            callback.call(
                {
                    lastID: primeiro?.id || 0,
                    changes: resultado.rowCount || 0
                },
                null
            );

        })
        .catch(erro => {

            callback.call(
                {
                    lastID: 0,
                    changes: 0
                },
                erro
            );

        });
    },

    all(sql, parametros = [], callback = () => {}) {

        if (!usandoPostgres) {

            if (!this._sqlite) {
                const sqlite3 = require("sqlite3").verbose();
                this._sqlite = new sqlite3.Database(caminhoBanco);
            }

            return this._sqlite.all(
                sql,
                parametros,
                callback
            );
        }

        if (/^PRAGMA\s+table_info/i.test(sql.trim())) {

            const tabela = sql.match(
                /PRAGMA\s+table_info\(([^)]+)\)/i
            );

            if (!tabela) {
                callback(
                    new Error("PRAGMA inválido."),
                    []
                );
                return;
            }

            const nomeTabela = tabela[1].replace(
                /["'`]/g,
                ""
            );

            pool.query(
                `
                SELECT
                    ordinal_position AS cid,
                    column_name AS name,
                    data_type AS type,
                    CASE
                        WHEN is_nullable = 'NO'
                        THEN 1
                        ELSE 0
                    END AS notnull
                FROM information_schema.columns
                WHERE table_schema = 'public'
                AND table_name = $1
                ORDER BY ordinal_position
                `,
                [nomeTabela.toLowerCase()]
            )
            .then(resultado => {
                callback(
                    null,
                    resultado.rows
                );
            })
            .catch(erro => {
                callback(
                    erro,
                    []
                );
            });

            return;
        }

        const sqlAdaptado = adaptarSqlPostgres(sql);

        const convertido = converterParametros(
            sqlAdaptado,
            parametros
        );

        pool.query(
            convertido.sql,
            convertido.parametros
        )
        .then(resultado => {
            callback(
                null,
                resultado.rows || []
            );
        })
        .catch(erro => {
            callback(
                erro,
                []
            );
        });
    },

    get(sql, parametros = [], callback = () => {}) {

        if (!usandoPostgres) {

            if (!this._sqlite) {
                const sqlite3 = require("sqlite3").verbose();
                this._sqlite = new sqlite3.Database(caminhoBanco);
            }

            return this._sqlite.get(
                sql,
                parametros,
                callback
            );
        }

        const sqlAdaptado = adaptarSqlPostgres(sql);

        const convertido = converterParametros(
            sqlAdaptado,
            parametros
        );

        pool.query(
            convertido.sql,
            convertido.parametros
        )
        .then(resultado => {

            callback(
                null,
                resultado.rows[0] || undefined
            );

        })
        .catch(erro => {

            callback(
                erro,
                undefined
            );

        });
    },

    serialize(callback) {
        callback();
    }
};

// =====================================================
// HELPERS DO BANCO
// =====================================================

function executar(sql, parametros = []) {
    return new Promise((resolve, reject) => {

        db.run(
            sql,
            parametros,
            function (erro) {

                if (erro) {
                    reject(erro);
                    return;
                }

                resolve({
                    id: this.lastID,
                    alterados: this.changes
                });
            }
        );

    });
}

function consultar(sql, parametros = []) {
    return new Promise((resolve, reject) => {

        db.all(
            sql,
            parametros,
            (erro, linhas) => {

                if (erro) {
                    reject(erro);
                    return;
                }

                resolve(linhas || []);
            }
        );

    });
}

function consultarUm(sql, parametros = []) {
    return new Promise((resolve, reject) => {

        db.get(
            sql,
            parametros,
            (erro, linha) => {

                if (erro) {
                    reject(erro);
                    return;
                }

                resolve(linha || null);
            }
        );

    });
}

// =====================================================
// CRIAÇÃO DO BANCO
// =====================================================

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS representantes (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL,
            usuario TEXT UNIQUE NOT NULL,
            senha TEXT NOT NULL,
            turma_id INTEGER,
            primeiro_acesso INTEGER DEFAULT 1,
            ativo INTEGER DEFAULT 1,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS turmas (
            id SERIAL PRIMARY KEY,
            nome TEXT NOT NULL,
            ano TEXT,
            turno TEXT,
            sala TEXT,
            ano_letivo TEXT,
            criada_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS alunos (
            id SERIAL PRIMARY KEY,
            turma_id INTEGER NOT NULL,
            nome TEXT NOT NULL,
            data_nascimento TEXT,
            foto TEXT,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS disciplinas (
            id SERIAL PRIMARY KEY,
            turma_id INTEGER NOT NULL,
            nome TEXT NOT NULL,
            carga_horaria INTEGER DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS notas (
            id SERIAL PRIMARY KEY,
            aluno_id INTEGER NOT NULL,
            disciplina_id INTEGER NOT NULL,
            etapa TEXT NOT NULL,
            nota REAL DEFAULT 0,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(aluno_id, disciplina_id, etapa)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS chamadas (
            id SERIAL PRIMARY KEY,
            aluno_id INTEGER NOT NULL,
            disciplina_id INTEGER,
            data TEXT NOT NULL,
            presente INTEGER NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(aluno_id, disciplina_id, data)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS advertencias (
            id SERIAL PRIMARY KEY,
            aluno_id INTEGER NOT NULL,
            descricao TEXT NOT NULL,
            data TEXT NOT NULL,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // =====================================================
    // ÍNDICES
    // =====================================================

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_alunos_turma
        ON alunos(turma_id)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_disciplinas_turma
        ON disciplinas(turma_id)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_notas_aluno
        ON notas(aluno_id)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_chamadas_aluno
        ON chamadas(aluno_id)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_chamadas_data
        ON chamadas(data)
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_advertencias_aluno
        ON advertencias(aluno_id)
    `);
});

// =====================================================
// MIGRAÇÃO DA TABELA REPRESENTANTES
// =====================================================

db.all(
    `PRAGMA table_info(representantes)`,
    [],
    (erro, colunas) => {

        if (erro) {
            console.error(
                "Erro ao verificar tabela representantes:",
                erro.message
            );
            return;
        }

        const nomesColunas = (colunas || []).map(
            coluna => coluna.name
        );

        // -------------------------------------------------
        // COLUNA ATIVO
        // -------------------------------------------------

        if (!nomesColunas.includes("ativo")) {

            db.run(`
                ALTER TABLE representantes
                ADD COLUMN ativo INTEGER DEFAULT 1
            `, erro => {

                if (erro) {
                    console.error(
                        "Erro ao adicionar coluna ativo:",
                        erro.message
                    );
                } else {
                    console.log(
                        "Coluna representantes.ativo adicionada."
                    );
                }

            });
        }

        // -------------------------------------------------
        // COLUNA CRIADO_EM
        // -------------------------------------------------

        if (!nomesColunas.includes("criado_em")) {

            db.run(`
                ALTER TABLE representantes
                ADD COLUMN criado_em DATETIME
            `, erro => {

                if (erro) {
                    console.error(
                        "Erro ao adicionar coluna criado_em:",
                        erro.message
                    );
                } else {
                    console.log(
                        "Coluna representantes.criado_em adicionada."
                    );
                }

            });
        }

    }
);


// =====================================================
// FUNÇÃO DE FREQUÊNCIA
// =====================================================

function calcularFrequencia(
    registros,
    frequenciaSemRegistro = 100
) {

    registros = registros || [];

    const totalDias = registros.length;

    const diasPresentes = registros.filter(
        registro =>
            Number(registro.presente) === 1
    ).length;

    const diasFaltados =
        totalDias - diasPresentes;

    // Cada dia representa 9 aulas.
    const totalAulas =
        totalDias * 9;

    const presencas =
        diasPresentes * 9;

    const faltas =
        diasFaltados * 9;

    let frequencia =
        frequenciaSemRegistro;

    if (totalAulas > 0) {

        frequencia = Number(
            (
                (presencas / totalAulas) * 100
            ).toFixed(2)
        );

    }

    return {
        totalDias,
        diasPresentes,
        diasFaltados,
        totalAulas,
        presencas,
        faltas,
        frequencia
    };
}


// =====================================================
// EXCLUIR TURMA
// =====================================================

app.delete(
    "/api/admin/turma/:id",
    async (req, res) => {

        const turmaId =
            Number(req.params.id);

        console.log("");
        console.log("========================================");
        console.log("INICIANDO EXCLUSÃO DE TURMA");
        console.log("ID:", turmaId);
        console.log("========================================");

        try {

            if (!turmaId || turmaId <= 0) {

                return res.status(400).json({
                    sucesso: false,
                    mensagem: "ID da turma inválido."
                });

            }

            // -------------------------------------------------
            // 1. VERIFICAR TURMA
            // -------------------------------------------------

            console.log(
                "1. Procurando turma..."
            );

            const turma =
                await consultarUm(
                    `
                    SELECT *
                    FROM turmas
                    WHERE id = ?
                    `,
                    [turmaId]
                );

            if (!turma) {

                return res.status(404).json({
                    sucesso: false,
                    mensagem: "Turma não encontrada."
                });

            }

            console.log(
                "Turma encontrada:",
                turma.nome
            );


            // -------------------------------------------------
            // 2. BUSCAR ALUNOS
            // -------------------------------------------------

            console.log(
                "2. Buscando alunos..."
            );

            const alunos =
                await consultar(
                    `
                    SELECT id
                    FROM alunos
                    WHERE turma_id = ?
                    `,
                    [turmaId]
                );

            console.log(
                "Alunos encontrados:",
                alunos.length
            );


            // -------------------------------------------------
            // 3. EXCLUIR DADOS DOS ALUNOS
            // -------------------------------------------------

            if (alunos.length > 0) {

                const idsAlunos =
                    alunos.map(
                        aluno => aluno.id
                    );

                const placeholders =
                    idsAlunos
                        .map(() => "?")
                        .join(",");


                // NOTAS

                console.log(
                    "3. Excluindo notas..."
                );

                await executar(
                    `
                    DELETE FROM notas
                    WHERE aluno_id IN (${placeholders})
                    `,
                    idsAlunos
                );


                // CHAMADAS

                console.log(
                    "4. Excluindo chamadas..."
                );

                await executar(
                    `
                    DELETE FROM chamadas
                    WHERE aluno_id IN (${placeholders})
                    `,
                    idsAlunos
                );


                // ADVERTÊNCIAS

                console.log(
                    "5. Excluindo advertências..."
                );

                await executar(
                    `
                    DELETE FROM advertencias
                    WHERE aluno_id IN (${placeholders})
                    `,
                    idsAlunos
                );

            }


            // -------------------------------------------------
            // 6. EXCLUIR DISCIPLINAS
            // -------------------------------------------------

            console.log(
                "6. Excluindo disciplinas..."
            );

            await executar(
                `
                DELETE FROM disciplinas
                WHERE turma_id = ?
                `,
                [turmaId]
            );


            // -------------------------------------------------
            // 7. EXCLUIR ALUNOS
            // -------------------------------------------------

            console.log(
                "7. Excluindo alunos..."
            );

            await executar(
                `
                DELETE FROM alunos
                WHERE turma_id = ?
                `,
                [turmaId]
            );


            // -------------------------------------------------
            // 8. DESVINCULAR REPRESENTANTE
            // -------------------------------------------------

            console.log(
                "8. Desvinculando representante..."
            );

            await executar(
                `
                UPDATE representantes
                SET turma_id = NULL
                WHERE turma_id = ?
                `,
                [turmaId]
            );


            // -------------------------------------------------
            // 9. EXCLUIR TURMA
            // -------------------------------------------------

            console.log(
                "9. Excluindo turma..."
            );

            const resultado =
                await executar(
                    `
                    DELETE FROM turmas
                    WHERE id = ?
                    `,
                    [turmaId]
                );


            if (!resultado.alterados) {

                return res.status(404).json({
                    sucesso: false,
                    mensagem:
                        "A turma não pôde ser excluída."
                });

            }


            console.log("");
            console.log(
                "========================================"
            );
            console.log(
                "TURMA EXCLUÍDA COM SUCESSO"
            );
            console.log(
                "========================================"
            );


            return res.json({
                sucesso: true,
                mensagem:
                    "Turma excluída com sucesso.",
                turmaId
            });

        } catch (erro) {

            console.error("");
            console.error(
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            );
            console.error(
                "ERRO REAL AO EXCLUIR TURMA"
            );
            console.error(
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            );
            console.error(
                "Mensagem:",
                erro.message
            );
            console.error(
                "Stack:",
                erro.stack
            );
            console.error(
                "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
            );

            return res.status(500).json({
                sucesso: false,
                mensagem:
                    "Erro interno ao excluir turma.",
                erro: erro.message
            });

        }

    }
);


// =====================================================
// STATUS DO SISTEMA
// =====================================================

app.get(
    "/api/status",
    async (req, res) => {

        try {

            const representantes =
                await consultarUm(
                    `
                    SELECT COUNT(*) AS total
                    FROM representantes
                    `
                );

            const turmas =
                await consultarUm(
                    `
                    SELECT COUNT(*) AS total
                    FROM turmas
                    `
                );

            const alunos =
                await consultarUm(
                    `
                    SELECT COUNT(*) AS total
                    FROM alunos
                    `
                );

            res.json({

                sucesso: true,

                servidor: "online",

                banco:
                    usandoPostgres
                        ? "PostgreSQL"
                        : caminhoBanco,

                representantes:
                    Number(
                        representantes?.total || 0
                    ),

                turmas:
                    Number(
                        turmas?.total || 0
                    ),

                alunos:
                    Number(
                        alunos?.total || 0
                    )

            });

        } catch (erro) {

            console.error(
                "Erro no status:",
                erro
            );

            res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao consultar status."

            });

        }

    }
);


// =====================================================
// LOGIN
// =====================================================

app.post(
    "/api/login",
    async (req, res) => {

        try {

            const usuario =
                String(
                    req.body.usuario || ""
                ).trim();

            const senha =
                String(
                    req.body.senha || ""
                );


            if (!usuario || !senha) {

                return res.status(400).json({

                    sucesso: false,

                    erro:
                        "Informe usuário e senha."

                });

            }


            const representante =
                await consultarUm(
                    `
                    SELECT
                        id,
                        nome,
                        usuario,
                        turma_id,
                        primeiro_acesso,
                        ativo
                    FROM representantes
                    WHERE usuario = ?
                    AND senha = ?
                    LIMIT 1
                    `,
                    [
                        usuario,
                        senha
                    ]
                );


            if (!representante) {

                return res.status(401).json({

                    sucesso: false,

                    erro:
                        "Usuário ou senha incorretos."

                });

            }


            if (
                Number(
                    representante.ativo
                ) !== 1
            ) {

                return res.status(403).json({

                    sucesso: false,

                    erro:
                        "Este usuário está desativado."

                });

            }


            let turma = null;


            if (representante.turma_id) {

                turma =
                    await consultarUm(
                        `
                        SELECT *
                        FROM turmas
                        WHERE id = ?
                        `,
                        [
                            representante.turma_id
                        ]
                    );

            }


            return res.json({

                sucesso: true,

                representante,

                turma

            });

        } catch (erro) {

            console.error(
                "Erro no login:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro interno no login."

            });

        }

    }
);


// =====================================================
// REPRESENTANTES
// =====================================================


// -----------------------------------------------------
// LISTAR REPRESENTANTES
// -----------------------------------------------------

app.get(
    "/api/representantes",
    async (req, res) => {

        try {

            const representantes =
                await consultar(
                    `
                    SELECT
                        id,
                        nome,
                        usuario,
                        turma_id,
                        primeiro_acesso,
                        ativo,
                        criado_em
                    FROM representantes
                    ORDER BY nome ASC
                    `
                );


            return res.json({

                sucesso: true,

                representantes

            });

        } catch (erro) {

            console.error(
                "Erro ao carregar representantes:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao carregar representantes."

            });

        }

    }
);


// -----------------------------------------------------
// BUSCAR REPRESENTANTE
// -----------------------------------------------------

app.get(
    "/api/representantes/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);


            if (!id) {

                return res.status(400).json({

                    sucesso: false,

                    erro:
                        "ID inválido."

                });

            }


            const representante =
                await consultarUm(
                    `
                    SELECT
                        id,
                        nome,
                        usuario,
                        turma_id,
                        primeiro_acesso,
                        ativo,
                        criado_em
                    FROM representantes
                    WHERE id = ?
                    `,
                    [id]
                );


            if (!representante) {

                return res.status(404).json({

                    sucesso: false,

                    erro:
                        "Representante não encontrado."

                });

            }


            return res.json({

                sucesso: true,

                representante

            });

        } catch (erro) {

            console.error(
                "Erro ao carregar representante:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao carregar representante."

            });

        }

    }
);


// -----------------------------------------------------
// EXCLUIR REPRESENTANTE
// -----------------------------------------------------

app.delete(
    "/api/representantes/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);


            if (!id || id <= 0) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "ID do representante inválido."

                });

            }


            const representante =
                await consultarUm(
                    `
                    SELECT
                        id,
                        nome,
                        usuario,
                        turma_id
                    FROM representantes
                    WHERE id = ?
                    `,
                    [id]
                );


            if (!representante) {

                return res.status(404).json({

                    sucesso: false,

                    mensagem:
                        "Representante não encontrado."

                });

            }


            await executar(
                `
                DELETE FROM representantes
                WHERE id = ?
                `,
                [id]
            );


            return res.json({

                sucesso: true,

                mensagem:
                    "Representante excluído com sucesso."

            });

        } catch (erro) {

            console.error(
                "Erro ao excluir representante:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                mensagem:
                    "Erro interno ao excluir representante.",

                erro:
                    erro.message

            });

        }

    }
);


// -----------------------------------------------------
// CRIAR ACESSO DE REPRESENTANTE
// -----------------------------------------------------

app.post(
    "/api/representantes",
    async (req, res) => {

        try {

            const usuario =
                String(
                    req.body.usuario || ""
                ).trim();

            const senha =
                String(
                    req.body.senha || ""
                );

            
            if (!usuario) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Digite o nome de usuário."

                });

            }


            if (!senha) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "Digite a senha."

                });

            }


            if (senha.length < 4) {

                return res.status(400).json({

                    sucesso: false,

                    mensagem:
                        "A senha precisa ter pelo menos 4 caracteres."

                });

            }


            const existente =
                await consultarUm(
                    `
                    SELECT id
                    FROM representantes
                    WHERE usuario = ?
                    `,
                    [usuario]
                );


            if (existente) {

                return res.status(409).json({

                    sucesso: false,

                    mensagem:
                        "Este nome de usuário já está cadastrado."

                });

            }


            const resultado =
                await executar(
                    `
                    INSERT INTO representantes
                    (
                        nome,
                        usuario,
                        senha,
                        turma_id,
                        primeiro_acesso,
                        ativo,
                        criado_em
                    )
                    VALUES
                    (
                        ?,
                        ?,
                        ?,
                        NULL,
                        1,
                        1,
                        CURRENT_TIMESTAMP
                    )
                    `,
                    [
                        usuario,
                        usuario,
                        senha
                    ]
                );


            const representante =
                await consultarUm(
                    `
                    SELECT
                        id,
                        nome,
                        usuario,
                        turma_id,
                        primeiro_acesso,
                        ativo,
                        criado_em
                    FROM representantes
                    WHERE id = ?
                    `,
                    [
                        resultado.id
                    ]
                );


            return res.status(201).json({

                sucesso: true,

                mensagem:
                    "Acesso de representante criado com sucesso.",

                representante

            });

        } catch (erro) {

            console.error(
                "Erro ao criar representante:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                mensagem:
                    "Erro interno ao criar o acesso."

            });

        }

    }
);


// -----------------------------------------------------
// ATUALIZAR REPRESENTANTE
// -----------------------------------------------------

app.put(
    "/api/representantes/:id",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);


            const representante =
                await consultarUm(
                    `
                    SELECT *
                    FROM representantes
                    WHERE id = ?
                    `,
                    [id]
                );


            if (!representante) {

                return res.status(404).json({

                    sucesso: false,

                    erro:
                        "Representante não encontrado."

                });

            }


            const nome =
                req.body.nome !== undefined
                    ? String(
                        req.body.nome
                    ).trim()
                    : representante.nome;


            const usuario =
                req.body.usuario !== undefined
                    ? String(
                        req.body.usuario
                    ).trim()
                    : representante.usuario;


            const turmaId =
                req.body.turma_id !== undefined
                    ? (
                        req.body.turma_id === null ||
                        req.body.turma_id === ""
                            ? null
                            : Number(
                                req.body.turma_id
                            )
                    )
                    : representante.turma_id;


            await executar(
                `
                UPDATE representantes
                SET
                    nome = ?,
                    usuario = ?,
                    turma_id = ?
                WHERE id = ?
                `,
                [
                    nome,
                    usuario,
                    turmaId,
                    id
                ]
            );


            return res.json({

                sucesso: true,

                mensagem:
                    "Representante atualizado."

            });

        } catch (erro) {

            console.error(
                "Erro ao atualizar representante:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao atualizar representante."

            });

        }

    }
);


// -----------------------------------------------------
// ALTERAR SENHA
// -----------------------------------------------------

app.put(
    "/api/representantes/:id/senha",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            const senha =
                String(
                    req.body.senha || ""
                );


            if (!senha) {

                return res.status(400).json({

                    sucesso: false,

                    erro:
                        "Informe a nova senha."

                });

            }


            if (senha.length < 4) {

                return res.status(400).json({

                    sucesso: false,

                    erro:
                        "A senha precisa ter pelo menos 4 caracteres."

                });

            }


            await executar(
                `
                UPDATE representantes
                SET senha = ?
                WHERE id = ?
                `,
                [
                    senha,
                    id
                ]
            );


            return res.json({

                sucesso: true,

                mensagem:
                    "Senha alterada."

            });

        } catch (erro) {

            console.error(
                "Erro ao alterar senha:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao alterar senha."

            });

        }

    }
);


// -----------------------------------------------------
// ALTERAR STATUS
// -----------------------------------------------------

app.put(
    "/api/representantes/:id/status",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            const ativo =
                Number(req.body.ativo) === 1
                    ? 1
                    : 0;


            await executar(
                `
                UPDATE representantes
                SET ativo = ?
                WHERE id = ?
                `,
                [
                    ativo,
                    id
                ]
            );


            return res.json({

                sucesso: true,

                ativo

            });

        } catch (erro) {

            console.error(
                "Erro ao alterar status:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao alterar status."

            });

        }

    }
);


// -----------------------------------------------------
// FINALIZAR PRIMEIRO ACESSO
// -----------------------------------------------------

app.post(
    "/api/representantes/:id/finalizar-primeiro-acesso",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);


            await executar(
                `
                UPDATE representantes
                SET primeiro_acesso = 0
                WHERE id = ?
                `,
                [id]
            );


            return res.json({

                sucesso: true

            });

        } catch (erro) {

            console.error(
                "Erro ao finalizar primeiro acesso:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao finalizar primeiro acesso."

            });

        }

    }
);


// -----------------------------------------------------
// RESETAR SENHA PELO ADM
// -----------------------------------------------------

app.post(
    "/api/representantes/:id/resetar-senha",
    async (req, res) => {

        try {

            const id =
                Number(req.params.id);

            const senha =
                String(
                    req.body.senha || "1234"
                );


            await executar(
                `
                UPDATE representantes
                SET senha = ?
                WHERE id = ?
                `,
                [
                    senha,
                    id
                ]
            );


            return res.json({

                sucesso: true,

                mensagem:
                    "Senha redefinida."

            });

        } catch (erro) {

            console.error(
                "Erro ao redefinir senha:",
                erro
            );

            return res.status(500).json({

                sucesso: false,

                erro:
                    "Erro ao redefinir senha."

            });

        }

    }
);

// =====================================================
// TURMAS
// =====================================================

app.get("/api/turmas", async (req, res) => {

    try {

        const turmas = await consultar(`
            SELECT *
            FROM turmas
            ORDER BY ano_letivo DESC, nome ASC
        `);

        res.json({
            sucesso: true,
            turmas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar turmas."
        });
    }
});

app.get("/api/turmas/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const turma = await consultarUm(`
            SELECT *
            FROM turmas
            WHERE id = ?
        `, [id]);

        if (!turma) {
            return res.status(404).json({
                sucesso: false,
                erro: "Turma não encontrada."
            });
        }

        res.json({
            sucesso: true,
            turma
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar turma."
        });
    }
});

app.post("/api/turmas", async (req, res) => {

    try {

        const nome = String(req.body.nome || "").trim();
        const ano = String(req.body.ano || "").trim();
        const turno = String(req.body.turno || "").trim();
        const sala = String(req.body.sala || "").trim();
        const anoLetivo = String(
            req.body.ano_letivo ||
            req.body.anoLetivo ||
            ""
        ).trim();

        const representanteId = req.body.representante_id
            ? Number(req.body.representante_id)
            : null;

        if (!nome) {
            return res.status(400).json({
                sucesso: false,
                erro: "Informe o nome da turma."
            });
        }

        const resultado = await executar(`
            INSERT INTO turmas
            (
                nome,
                ano,
                turno,
                sala,
                ano_letivo
            )
            VALUES (?, ?, ?, ?, ?)
        `, [
            nome,
            ano,
            turno,
            sala,
            anoLetivo
        ]);

        const turma = await consultarUm(`
            SELECT *
            FROM turmas
            WHERE id = ?
        `, [resultado.id]);

        if (representanteId) {

            await executar(`
                UPDATE representantes
                SET turma_id = ?
                WHERE id = ?
            `, [
                resultado.id,
                representanteId
            ]);
        }

        res.status(201).json({
            sucesso: true,
            turma
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao criar turma."
        });
    }
});

app.put("/api/turmas/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const turma = await consultarUm(`
            SELECT *
            FROM turmas
            WHERE id = ?
        `, [id]);

        if (!turma) {
            return res.status(404).json({
                sucesso: false,
                erro: "Turma não encontrada."
            });
        }

        const nome = req.body.nome ?? turma.nome;
        const ano = req.body.ano ?? turma.ano;
        const turno = req.body.turno ?? turma.turno;
        const sala = req.body.sala ?? turma.sala;
        const anoLetivo =
            req.body.ano_letivo ??
            req.body.anoLetivo ??
            turma.ano_letivo;

        await executar(`
            UPDATE turmas
            SET nome = ?,
                ano = ?,
                turno = ?,
                sala = ?,
                ano_letivo = ?
            WHERE id = ?
        `, [
            nome,
            ano,
            turno,
            sala,
            anoLetivo,
            id
        ]);

        res.json({
            sucesso: true,
            mensagem: "Turma atualizada."
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao atualizar turma."
        });
    }
});

// =====================================================
// ALUNOS
// =====================================================

app.get("/api/alunos/turma/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        if (!turmaId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma inválida."
            });
        }

        const alunos = await consultar(`
            SELECT
                id,
                turma_id,
                nome,
                data_nascimento,
                foto,
                criado_em
            FROM alunos
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        // Retorna array diretamente porque as páginas
        // de cadastro/listagem trabalham com array.
        res.json(alunos);

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar alunos."
        });
    }
});

app.get("/api/alunos/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const aluno = await consultarUm(`
            SELECT *
            FROM alunos
            WHERE id = ?
        `, [id]);

        if (!aluno) {
            return res.status(404).json({
                sucesso: false,
                erro: "Aluno não encontrado."
            });
        }

        res.json({
            sucesso: true,
            aluno
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar aluno."
        });
    }
});

// Compatibilidade com versões anteriores
app.get("/api/aluno/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const aluno = await consultarUm(`
            SELECT *
            FROM alunos
            WHERE id = ?
        `, [id]);

        if (!aluno) {
            return res.status(404).json({
                sucesso: false,
                erro: "Aluno não encontrado."
            });
        }

        res.json({
            sucesso: true,
            aluno
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar aluno."
        });
    }
});

app.post("/api/alunos", async (req, res) => {

    try {

        const turmaId = Number(
            req.body.turma_id ||
            req.body.turmaId
        );

        const nome = String(req.body.nome || "").trim();

        const dataNascimento = String(
            req.body.data_nascimento ||
            req.body.dataNascimento ||
            ""
        ).trim();

        const foto = String(req.body.foto || "").trim();

        if (!turmaId || !nome) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma e nome do aluno são obrigatórios."
            });
        }

        const duplicado = await consultarUm(`
            SELECT id
            FROM alunos
            WHERE turma_id = ?
            AND LOWER(TRIM(nome)) = LOWER(TRIM(?))
        `, [
            turmaId,
            nome
        ]);

        if (duplicado) {
            return res.status(409).json({
                sucesso: false,
                erro: "Já existe um aluno com este nome nesta turma."
            });
        }

        const resultado = await executar(`
            INSERT INTO alunos
            (
                turma_id,
                nome,
                data_nascimento,
                foto
            )
            VALUES (?, ?, ?, ?)
        `, [
            turmaId,
            nome,
            dataNascimento || null,
            foto || null
        ]);

        const aluno = await consultarUm(`
            SELECT *
            FROM alunos
            WHERE id = ?
        `, [resultado.id]);

        res.status(201).json({
            sucesso: true,
            aluno
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao cadastrar aluno."
        });
    }
});

app.put("/api/alunos/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const aluno = await consultarUm(`
            SELECT *
            FROM alunos
            WHERE id = ?
        `, [id]);

        if (!aluno) {
            return res.status(404).json({
                sucesso: false,
                erro: "Aluno não encontrado."
            });
        }

        const nome = req.body.nome !== undefined
            ? String(req.body.nome).trim()
            : aluno.nome;

        const dataNascimento =
            req.body.data_nascimento !== undefined
                ? req.body.data_nascimento
                : (
                    req.body.dataNascimento !== undefined
                        ? req.body.dataNascimento
                        : aluno.data_nascimento
                );

        const foto = req.body.foto !== undefined
            ? req.body.foto
            : aluno.foto;

        await executar(`
            UPDATE alunos
            SET nome = ?,
                data_nascimento = ?,
                foto = ?
            WHERE id = ?
        `, [
            nome,
            dataNascimento || null,
            foto || null,
            id
        ]);

        res.json({
            sucesso: true,
            mensagem: "Aluno atualizado."
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao atualizar aluno."
        });
    }
});

app.delete("/api/alunos/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        await executar(`
            DELETE FROM chamadas
            WHERE aluno_id = ?
        `, [id]);

        await executar(`
            DELETE FROM notas
            WHERE aluno_id = ?
        `, [id]);

        await executar(`
            DELETE FROM advertencias
            WHERE aluno_id = ?
        `, [id]);

        const resultado = await executar(`
            DELETE FROM alunos
            WHERE id = ?
        `, [id]);

        if (!resultado.alterados) {
            return res.status(404).json({
                sucesso: false,
                erro: "Aluno não encontrado."
            });
        }

        res.json({
            sucesso: true,
            mensagem: "Aluno excluído."
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao excluir aluno."
        });
    }
});

// =====================================================
// DISCIPLINAS
// =====================================================

app.get("/api/disciplinas/turma/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        const disciplinas = await consultar(`
            SELECT
                id,
                turma_id,
                nome,
                carga_horaria
            FROM disciplinas
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        res.json({
            sucesso: true,
            disciplinas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar disciplinas."
        });
    }
});

// Compatibilidade antiga
app.get("/api/disciplinas/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        const disciplinas = await consultar(`
            SELECT
                id,
                turma_id,
                nome,
                carga_horaria
            FROM disciplinas
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        res.json({
            sucesso: true,
            disciplinas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar disciplinas."
        });
    }
});

app.post("/api/disciplinas", async (req, res) => {

    try {

        const turmaId = Number(
            req.body.turma_id ||
            req.body.turmaId
        );

        const nome = String(req.body.nome || "").trim();

        const cargaHoraria = Number(
            req.body.carga_horaria ||
            req.body.cargaHoraria ||
            0
        );

        if (!turmaId || !nome) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma e nome da disciplina são obrigatórios."
            });
        }

        const existente = await consultarUm(`
            SELECT id
            FROM disciplinas
            WHERE turma_id = ?
            AND LOWER(TRIM(nome)) = LOWER(TRIM(?))
        `, [
            turmaId,
            nome
        ]);

        if (existente) {
            return res.status(409).json({
                sucesso: false,
                erro: "Esta disciplina já existe na turma."
            });
        }

        const resultado = await executar(`
            INSERT INTO disciplinas
            (
                turma_id,
                nome,
                carga_horaria
            )
            VALUES (?, ?, ?)
        `, [
            turmaId,
            nome,
            cargaHoraria
        ]);

        const disciplina = await consultarUm(`
            SELECT *
            FROM disciplinas
            WHERE id = ?
        `, [resultado.id]);

        res.status(201).json({
            sucesso: true,
            disciplina
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao cadastrar disciplina."
        });
    }
});

app.put("/api/disciplinas/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const disciplina = await consultarUm(`
            SELECT *
            FROM disciplinas
            WHERE id = ?
        `, [id]);

        if (!disciplina) {
            return res.status(404).json({
                sucesso: false,
                erro: "Disciplina não encontrada."
            });
        }

        const nome = req.body.nome ?? disciplina.nome;

        const cargaHoraria =
            req.body.carga_horaria ??
            req.body.cargaHoraria ??
            disciplina.carga_horaria;

        await executar(`
            UPDATE disciplinas
            SET nome = ?,
                carga_horaria = ?
            WHERE id = ?
        `, [
            nome,
            Number(cargaHoraria) || 0,
            id
        ]);

        res.json({
            sucesso: true
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao atualizar disciplina."
        });
    }
});

app.delete("/api/disciplinas/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        await executar(`
            DELETE FROM notas
            WHERE disciplina_id = ?
        `, [id]);

        await executar(`
            DELETE FROM chamadas
            WHERE disciplina_id = ?
        `, [id]);

        const resultado = await executar(`
            DELETE FROM disciplinas
            WHERE id = ?
        `, [id]);

        if (!resultado.alterados) {
            return res.status(404).json({
                sucesso: false,
                erro: "Disciplina não encontrada."
            });
        }

        res.json({
            sucesso: true
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao excluir disciplina."
        });
    }
});

// =====================================================
// NOTAS
// =====================================================

app.get("/api/notas/aluno/:alunoId", async (req, res) => {

    try {

        const alunoId = Number(req.params.alunoId);

        const notas = await consultar(`
            SELECT
                notas.id,
                notas.aluno_id,
                notas.disciplina_id,
                notas.etapa,
                notas.nota,
                disciplinas.nome AS disciplina_nome,
                disciplinas.carga_horaria
            FROM notas
            LEFT JOIN disciplinas
                ON disciplinas.id = notas.disciplina_id
            WHERE notas.aluno_id = ?
            ORDER BY disciplinas.nome ASC, notas.etapa ASC
        `, [alunoId]);

        res.json({
            sucesso: true,
            notas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar notas."
        });
    }
});

app.get("/api/notas/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        const notas = await consultar(`
            SELECT
                notas.*,
                alunos.nome AS aluno_nome,
                disciplinas.nome AS disciplina_nome
            FROM notas
            INNER JOIN alunos
                ON alunos.id = notas.aluno_id
            INNER JOIN disciplinas
                ON disciplinas.id = notas.disciplina_id
            WHERE alunos.turma_id = ?
            ORDER BY alunos.nome ASC,
                     disciplinas.nome ASC,
                     notas.etapa ASC
        `, [turmaId]);

        res.json({
            sucesso: true,
            notas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar notas."
        });
    }
});

app.post("/api/notas", (req, res) => {
    const aluno_id = Number(req.body.aluno_id);
    const disciplina_id = Number(req.body.disciplina_id);
    const etapa = String(req.body.etapa || "").trim();
    const nota = Number(req.body.nota);

    if (!aluno_id || !disciplina_id || !etapa) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "Aluno, disciplina e etapa são obrigatórios."
        });
    }

    if (Number.isNaN(nota)) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "A nota precisa ser um número."
        });
    }

    if (nota < 0 || nota > 40) {
        return res.status(400).json({
            sucesso: false,
            mensagem: "A nota está fora do limite permitido."
        });
    }

    const sqlVerificar = `
        SELECT id
        FROM notas
        WHERE aluno_id = ?
          AND disciplina_id = ?
          AND etapa = ?
        LIMIT 1
    `;

    db.get(
        sqlVerificar,
        [aluno_id, disciplina_id, etapa],
        (erroBusca, registro) => {

            if (erroBusca) {
                console.error("Erro ao verificar nota:", erroBusca);

                return res.status(500).json({
                    sucesso: false,
                    mensagem: "Erro ao verificar nota.",
                    erro: erroBusca.message
                });
            }

            // Se a nota já existe, atualiza
            if (registro) {
                const sqlAtualizar = `
                    UPDATE notas
                    SET nota = ?
                    WHERE id = ?
                `;

                db.run(
                    sqlAtualizar,
                    [nota, registro.id],
                    function (erroUpdate) {

                        if (erroUpdate) {
                            console.error("Erro ao atualizar nota:", erroUpdate);

                            return res.status(500).json({
                                sucesso: false,
                                mensagem: "Erro ao atualizar nota.",
                                erro: erroUpdate.message
                            });
                        }

                        return res.json({
                            sucesso: true,
                            mensagem: "Nota atualizada com sucesso.",
                            nota: {
                                id: registro.id,
                                aluno_id,
                                disciplina_id,
                                etapa,
                                nota
                            }
                        });
                    }
                );

                return;
            }

            // Se não existe, cria
            const sqlInserir = `
                INSERT INTO notas (
                    aluno_id,
                    disciplina_id,
                    etapa,
                    nota
                )
                VALUES (?, ?, ?, ?)
            `;

            db.run(
                sqlInserir,
                [aluno_id, disciplina_id, etapa, nota],
                function (erroInsert) {

                    if (erroInsert) {
                        console.error("Erro ao inserir nota:", erroInsert);

                        return res.status(500).json({
                            sucesso: false,
                            mensagem: "Erro ao inserir nota.",
                            erro: erroInsert.message
                        });
                    }

                    return res.json({
                        sucesso: true,
                        mensagem: "Nota salva com sucesso.",
                        nota: {
                            id: this.lastID,
                            aluno_id,
                            disciplina_id,
                            etapa,
                            nota
                        }
                    });
                }
            );
        }
    );
});

// =====================================================
// CHAMADAS
// =====================================================

// -----------------------------------------------------
// CHAMADAS DA TURMA
// -----------------------------------------------------

app.get("/api/chamadas/turma/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        if (!turmaId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma inválida."
            });
        }

        const chamadas = await consultar(`
            SELECT
                chamadas.id,
                chamadas.aluno_id,
                chamadas.disciplina_id,
                chamadas.data,
                chamadas.presente,
                alunos.nome AS aluno_nome
            FROM chamadas
            INNER JOIN alunos
                ON alunos.id = chamadas.aluno_id
            WHERE alunos.turma_id = ?
            AND chamadas.disciplina_id IS NULL
            ORDER BY chamadas.data DESC,
                     alunos.nome ASC
        `, [turmaId]);

        res.json({
            sucesso: true,
            chamadas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar chamadas."
        });
    }
});

// Compatibilidade com versão antiga
app.get("/api/chamadas/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        const chamadas = await consultar(`
            SELECT
                chamadas.id,
                chamadas.aluno_id,
                chamadas.disciplina_id,
                chamadas.data,
                chamadas.presente,
                alunos.nome AS aluno_nome
            FROM chamadas
            INNER JOIN alunos
                ON alunos.id = chamadas.aluno_id
            WHERE alunos.turma_id = ?
            AND chamadas.disciplina_id IS NULL
            ORDER BY chamadas.data DESC,
                     alunos.nome ASC
        `, [turmaId]);

        res.json({
            sucesso: true,
            chamadas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar chamadas."
        });
    }
});

// -----------------------------------------------------
// CHAMADAS DO ALUNO
// -----------------------------------------------------

app.get("/api/chamadas/aluno/:alunoId", async (req, res) => {

    try {

        const alunoId = Number(req.params.alunoId);

        if (!alunoId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Aluno inválido."
            });
        }

        const chamadas = await consultar(`
            SELECT
                id,
                aluno_id,
                disciplina_id,
                data,
                presente
            FROM chamadas
            WHERE aluno_id = ?
            AND disciplina_id IS NULL
            ORDER BY data DESC
        `, [alunoId]);

        res.json({
            sucesso: true,
            chamadas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar chamadas do aluno."
        });
    }
});

// -----------------------------------------------------
// REGISTRAR CHAMADA
// -----------------------------------------------------

app.post("/api/chamadas", async (req, res) => {

    try {

        const alunoId = Number(
            req.body.aluno_id ||
            req.body.alunoId
        );

        const data = String(
            req.body.data || ""
        ).trim();

        const presente =
            Number(req.body.presente) === 1 ||
            req.body.presente === true
                ? 1
                : 0;

        if (!alunoId || !data) {
            return res.status(400).json({
                sucesso: false,
                erro: "Aluno e data são obrigatórios."
            });
        }

        // IMPORTANTE:
        // chamada diária sempre possui disciplina_id NULL.
        // Isso permite que a frequência geral seja calculada
        // sem misturar chamadas por disciplina.

        const existente = await consultarUm(`
            SELECT id
            FROM chamadas
            WHERE aluno_id = ?
            AND data = ?
            AND disciplina_id IS NULL
            LIMIT 1
        `, [
            alunoId,
            data
        ]);

        if (existente) {

            await executar(`
                UPDATE chamadas
                SET presente = ?
                WHERE id = ?
            `, [
                presente,
                existente.id
            ]);

        } else {

            await executar(`
                INSERT INTO chamadas
                (
                    aluno_id,
                    disciplina_id,
                    data,
                    presente
                )
                VALUES (?, NULL, ?, ?)
            `, [
                alunoId,
                data,
                presente
            ]);
        }

        res.json({
            sucesso: true,
            mensagem: "Chamada salva.",
            aluno_id: alunoId,
            data,
            presente
        });

    } catch (erro) {

        console.error("Erro ao salvar chamada:", erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao salvar chamada."
        });
    }
});

// =====================================================
// FREQUÊNCIA INDIVIDUAL
// =====================================================

app.get("/api/frequencia/aluno/:alunoId", async (req, res) => {

    try {

        const alunoId = Number(req.params.alunoId);

        if (!alunoId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Aluno inválido."
            });
        }

        const registros = await consultar(`
            SELECT
                id,
                aluno_id,
                data,
                presente
            FROM chamadas
            WHERE aluno_id = ?
            AND disciplina_id IS NULL
            ORDER BY data ASC
        `, [alunoId]);

        const frequencia = calcularFrequencia(
            registros,
            100
        );

        res.json({
            sucesso: true,
            alunoId,
            ...frequencia,
            percentual: frequencia.frequencia
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao calcular frequência."
        });
    }
});

// =====================================================
// FREQUÊNCIA DA TURMA
// =====================================================

app.get("/api/frequencia/turma/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        if (!turmaId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma inválida."
            });
        }

        const alunos = await consultar(`
            SELECT
                id,
                nome
            FROM alunos
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        const chamadas = await consultar(`
            SELECT
                chamadas.id,
                chamadas.aluno_id,
                chamadas.data,
                chamadas.presente
            FROM chamadas
            INNER JOIN alunos
                ON alunos.id = chamadas.aluno_id
            WHERE alunos.turma_id = ?
            AND chamadas.disciplina_id IS NULL
            ORDER BY chamadas.data ASC
        `, [turmaId]);

        const alunosFrequencia = alunos.map(aluno => {

            const registros = chamadas.filter(
                chamada =>
                    Number(chamada.aluno_id) === Number(aluno.id)
            );

            const dados = calcularFrequencia(
                registros,
                100
            );

            return {
                alunoId: aluno.id,
                nome: aluno.nome,
                ...dados
            };
        });

        // Para a média da turma:
        // alunos que ainda não tiveram nenhuma chamada
        // não entram na média.
        const alunosComChamada =
            alunosFrequencia.filter(
                aluno => aluno.totalDias > 0
            );

        const frequenciaMedia =
            alunosComChamada.length > 0
                ? Number(
                    (
                        alunosComChamada.reduce(
                            (total, aluno) =>
                                total + aluno.frequencia,
                            0
                        ) / alunosComChamada.length
                    ).toFixed(2)
                )
                : 0;

        res.json({
            sucesso: true,
            turmaId,
            frequenciaMedia,
            alunos: alunosFrequencia
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao calcular frequência da turma."
        });
    }
});

// =====================================================
// ADVERTÊNCIAS
// =====================================================

app.get("/api/advertencias/aluno/:alunoId", async (req, res) => {

    try {

        const alunoId = Number(req.params.alunoId);

        const advertencias = await consultar(`
            SELECT *
            FROM advertencias
            WHERE aluno_id = ?
            ORDER BY data DESC, id DESC
        `, [alunoId]);

        res.json({
            sucesso: true,
            advertencias
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar advertências."
        });
    }
});

app.post("/api/advertencias", async (req, res) => {

    try {

        const alunoId = Number(
            req.body.aluno_id ||
            req.body.alunoId
        );

        const descricao = String(
            req.body.descricao || ""
        ).trim();

        const data = String(
            req.body.data ||
            new Date().toISOString().slice(0, 10)
        ).trim();

        if (!alunoId || !descricao) {
            return res.status(400).json({
                sucesso: false,
                erro: "Aluno e descrição são obrigatórios."
            });
        }

        const resultado = await executar(`
            INSERT INTO advertencias
            (
                aluno_id,
                descricao,
                data
            )
            VALUES (?, ?, ?)
        `, [
            alunoId,
            descricao,
            data
        ]);

        res.status(201).json({
            sucesso: true,
            id: resultado.id
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao registrar advertência."
        });
    }
});

app.delete("/api/advertencias/:id", async (req, res) => {

    try {

        const id = Number(req.params.id);

        const resultado = await executar(`
            DELETE FROM advertencias
            WHERE id = ?
        `, [id]);

        if (!resultado.alterados) {
            return res.status(404).json({
                sucesso: false,
                erro: "Advertência não encontrada."
            });
        }

        res.json({
            sucesso: true
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao excluir advertência."
        });
    }
});

// =====================================================
// RESUMO DO ALUNO
// =====================================================

app.get("/api/resumo-aluno/:alunoId", async (req, res) => {

    try {

        const alunoId = Number(req.params.alunoId);

        const aluno = await consultarUm(`
            SELECT *
            FROM alunos
            WHERE id = ?
        `, [alunoId]);

        if (!aluno) {
            return res.status(404).json({
                sucesso: false,
                erro: "Aluno não encontrado."
            });
        }

        const chamadas = await consultar(`
            SELECT
                data,
                presente
            FROM chamadas
            WHERE aluno_id = ?
            AND disciplina_id IS NULL
        `, [alunoId]);

        const frequencia = calcularFrequencia(
            chamadas,
            100
        );

        const notas = await consultar(`
            SELECT
                notas.*,
                disciplinas.nome AS disciplina_nome
            FROM notas
            LEFT JOIN disciplinas
                ON disciplinas.id = notas.disciplina_id
            WHERE notas.aluno_id = ?
            ORDER BY disciplinas.nome ASC, notas.etapa ASC
        `, [alunoId]);

        const advertencias = await consultar(`
            SELECT *
            FROM advertencias
            WHERE aluno_id = ?
            ORDER BY data DESC, id DESC
        `, [alunoId]);

        const mediaNotas = notas.length > 0
            ? Number(
                (
                    notas.reduce(
                        (total, item) =>
                            total + Number(item.nota || 0),
                        0
                    ) / notas.length
                ).toFixed(2)
            )
            : 0;

        const disciplinas = await consultar(`
            SELECT DISTINCT
                disciplinas.id,
                disciplinas.nome
            FROM disciplinas
            INNER JOIN notas
                ON notas.disciplina_id = disciplinas.id
            WHERE notas.aluno_id = ?
            ORDER BY disciplinas.nome ASC
        `, [alunoId]);

        res.json({
            sucesso: true,

            aluno,

            frequencia: {
                ...frequencia,
                percentual: frequencia.frequencia
            },

            media: mediaNotas,

            notas,

            advertencias,

            disciplinas
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar resumo do aluno."
        });
    }
});

// =====================================================
// DADOS DA TURMA / DASHBOARD
// =====================================================

app.get("/api/dados-turma/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        if (!turmaId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma inválida."
            });
        }

        const turma = await consultarUm(`
            SELECT *
            FROM turmas
            WHERE id = ?
        `, [turmaId]);

        if (!turma) {
            return res.status(404).json({
                sucesso: false,
                erro: "Turma não encontrada."
            });
        }

        const alunos = await consultar(`
            SELECT *
            FROM alunos
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        const chamadas = await consultar(`
            SELECT
                chamadas.aluno_id,
                chamadas.data,
                chamadas.presente
            FROM chamadas
            INNER JOIN alunos
                ON alunos.id = chamadas.aluno_id
            WHERE alunos.turma_id = ?
            AND chamadas.disciplina_id IS NULL
            ORDER BY chamadas.data ASC
        `, [turmaId]);

        const notas = await consultar(`
            SELECT
                notas.aluno_id,
                notas.disciplina_id,
                notas.etapa,
                notas.nota,
                disciplinas.nome AS disciplina_nome
            FROM notas
            INNER JOIN alunos
                ON alunos.id = notas.aluno_id
            LEFT JOIN disciplinas
                ON disciplinas.id = notas.disciplina_id
            WHERE alunos.turma_id = ?
        `, [turmaId]);

        const advertencias = await consultar(`
            SELECT
                advertencias.*
            FROM advertencias
            INNER JOIN alunos
                ON alunos.id = advertencias.aluno_id
            WHERE alunos.turma_id = ?
            ORDER BY advertencias.data DESC
        `, [turmaId]);

        // ---------------------------------------------
        // FREQUÊNCIA DE CADA ALUNO
        // ---------------------------------------------

        const alunosComDados = alunos.map(aluno => {

            const registros = chamadas.filter(
                chamada =>
                    Number(chamada.aluno_id) === Number(aluno.id)
            );

            const frequencia = calcularFrequencia(
                registros,
                100
            );

            return {
                ...aluno,
                frequencia: frequencia.frequencia,
                totalAulas: frequencia.totalAulas,
                presencas: frequencia.presencas,
                faltas: frequencia.faltas,
                totalDias: frequencia.totalDias,
                diasPresentes: frequencia.diasPresentes,
                diasFaltados: frequencia.diasFaltados
            };
        });

        // ---------------------------------------------
        // MÉDIA DE FREQUÊNCIA DA TURMA
        // ---------------------------------------------

        const alunosComChamada =
            alunosComDados.filter(
                aluno => aluno.totalDias > 0
            );

        const frequenciaMedia =
            alunosComChamada.length > 0
                ? Number(
                    (
                        alunosComChamada.reduce(
                            (total, aluno) =>
                                total + Number(aluno.frequencia),
                            0
                        ) / alunosComChamada.length
                    ).toFixed(2)
                )
                : 0;

        // ---------------------------------------------
        // MÉDIA GERAL DOS ALUNOS
        // ---------------------------------------------

        const mediasPorAluno = alunos.map(aluno => {

            const notasAluno = notas.filter(
                nota =>
                    Number(nota.aluno_id) === Number(aluno.id)
            );

            if (!notasAluno.length) {
                return {
                    alunoId: aluno.id,
                    media: 0
                };
            }

            const media =
                notasAluno.reduce(
                    (total, nota) =>
                        total + Number(nota.nota || 0),
                    0
                ) / notasAluno.length;

            return {
                alunoId: aluno.id,
                media: Number(media.toFixed(2))
            };
        });

        const alunosComNotas =
            mediasPorAluno.filter(
                aluno => aluno.media > 0
            );

        const notaMedia =
            alunosComNotas.length > 0
                ? Number(
                    (
                        alunosComNotas.reduce(
                            (total, aluno) =>
                                total + aluno.media,
                            0
                        ) / alunosComNotas.length
                    ).toFixed(2)
                )
                : 0;

        // ---------------------------------------------
        // MÉDIA POR DISCIPLINA
        // ---------------------------------------------

        const disciplinasMap = {};

        notas.forEach(nota => {

            const nome = nota.disciplina_nome || "Sem disciplina";

            if (!disciplinasMap[nome]) {
                disciplinasMap[nome] = [];
            }

            disciplinasMap[nome].push(
                Number(nota.nota || 0)
            );
        });

        const desempenho = Object.keys(disciplinasMap)
            .map(nome => {

                const valores = disciplinasMap[nome];

                const media =
                    valores.reduce(
                        (total, valor) =>
                            total + valor,
                        0
                    ) / valores.length;

                return {
                    disciplina: nome,
                    media: Number(media.toFixed(2))
                };
            })
            .sort(
                (a, b) =>
                    b.media - a.media
            );

        // ---------------------------------------------
        // HISTÓRICO DE FREQUÊNCIA
        // ---------------------------------------------

        const datas = [
            ...new Set(
                chamadas.map(
                    chamada => chamada.data
                )
            )
        ].sort();

        const frequenciaHistorico = datas.map(data => {

            const registrosDoDia =
                chamadas.filter(
                    chamada =>
                        chamada.data === data
                );

            const presentes =
                registrosDoDia.filter(
                    chamada =>
                        Number(chamada.presente) === 1
                ).length;

            const total =
                registrosDoDia.length;

            const percentual =
                total > 0
                    ? Number(
                        (
                            (presentes / total) *
                            100
                        ).toFixed(2)
                    )
                    : 0;

            return {
                data,
                frequencia: percentual,
                presentes,
                faltas: total - presentes
            };
        });

        res.json({
            sucesso: true,

            turma,

            totalAlunos: alunos.length,

            alunos: alunosComDados,

            frequencia: frequenciaMedia,

            frequenciaMedia,

            notaMedia,

            totalAdvertencias:
                advertencias.length,

            advertencias,

            notas,

            disciplinas: desempenho,

            desempenho,

            frequenciaHistorico,

            historicoFrequencia:
                frequenciaHistorico,

            atividadeRecente:
                chamadas
                    .slice()
                    .reverse()
                    .slice(0, 10)
                    .map(item => ({
                        tipo: "chamada",
                        data: item.data,
                        aluno_id: item.aluno_id,
                        presente:
                            Number(item.presente) === 1
                    }))
        });

    } catch (erro) {

        console.error(
            "Erro em dados-turma:",
            erro
        );

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar dados da turma."
        });
    }
});

// =====================================================
// PAINEL DO REPRESENTANTE
// =====================================================

app.get("/api/painel/:representanteId", async (req, res) => {

    try {

        const representanteId =
            Number(req.params.representanteId);

        const representante =
            await consultarUm(`
                SELECT
                    id,
                    nome,
                    usuario,
                    turma_id,
                    primeiro_acesso,
                    ativo
                FROM representantes
                WHERE id = ?
            `, [representanteId]);

        if (!representante) {
            return res.status(404).json({
                sucesso: false,
                erro: "Representante não encontrado."
            });
        }

        let turma = null;

        if (representante.turma_id) {

            turma = await consultarUm(`
                SELECT *
                FROM turmas
                WHERE id = ?
            `, [representante.turma_id]);

        }

        res.json({
            sucesso: true,
            representante,
            turma
        });

    } catch (erro) {

        console.error(erro);

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar painel."
        });
    }
});
// =====================================================
// PAINEL ADMINISTRATIVO
// =====================================================

// -----------------------------------------------------
// RESUMO GERAL DA ESCOLA
// -----------------------------------------------------

app.get("/api/admin/escola", async (req, res) => {

    try {

        const turmas = await consultar(`
            SELECT *
            FROM turmas
            ORDER BY ano_letivo DESC, nome ASC
        `);

        const representantes = await consultar(`
            SELECT
                representantes.id,
                representantes.nome,
                representantes.usuario,
                representantes.turma_id,
                representantes.ativo,
                representantes.criado_em,
                turmas.nome AS turma_nome
            FROM representantes
            LEFT JOIN turmas
                ON turmas.id = representantes.turma_id
            ORDER BY representantes.nome ASC
        `);

        const alunos = await consultar(`
            SELECT
                alunos.id,
                alunos.nome,
                alunos.turma_id
            FROM alunos
            ORDER BY alunos.nome ASC
        `);

        const chamadas = await consultar(`
            SELECT
                chamadas.id,
                chamadas.aluno_id,
                chamadas.data,
                chamadas.presente,
                alunos.turma_id
            FROM chamadas
            INNER JOIN alunos
                ON alunos.id = chamadas.aluno_id
            WHERE chamadas.disciplina_id IS NULL
            ORDER BY chamadas.data ASC
        `);

        const notas = await consultar(`
            SELECT
                notas.id,
                notas.aluno_id,
                notas.nota,
                alunos.turma_id
            FROM notas
            INNER JOIN alunos
                ON alunos.id = notas.aluno_id
        `);

        const advertencias = await consultar(`
            SELECT
                advertencias.id,
                advertencias.aluno_id,
                alunos.turma_id
            FROM advertencias
            INNER JOIN alunos
                ON alunos.id = advertencias.aluno_id
        `);

        // -------------------------------------------------
        // DADOS DE CADA TURMA
        // -------------------------------------------------

        const turmasComDados = turmas.map(turma => {

            const alunosTurma = alunos.filter(
                aluno =>
                    Number(aluno.turma_id) === Number(turma.id)
            );

            const idsAlunos = new Set(
                alunosTurma.map(aluno => Number(aluno.id))
            );

            const chamadasTurma = chamadas.filter(
                chamada =>
                    idsAlunos.has(Number(chamada.aluno_id))
            );

            const notasTurma = notas.filter(
                nota =>
                    idsAlunos.has(Number(nota.aluno_id))
            );

            const advertenciasTurma = advertencias.filter(
                advertencia =>
                    idsAlunos.has(Number(advertencia.aluno_id))
            );

            // Frequência dos alunos
            const frequencias = alunosTurma.map(aluno => {

                const registros = chamadasTurma.filter(
                    chamada =>
                        Number(chamada.aluno_id) === Number(aluno.id)
                );

                return calcularFrequencia(registros, 100);
            });

            const alunosComChamada = frequencias.filter(
                dados =>
                    dados.totalDias > 0
            );

            const frequenciaMedia =
                alunosComChamada.length > 0
                    ? Number(
                        (
                            alunosComChamada.reduce(
                                (total, dados) =>
                                    total + dados.frequencia,
                                0
                            ) / alunosComChamada.length
                        ).toFixed(2)
                    )
                    : 0;

            // Média das notas
            const notaMedia =
                notasTurma.length > 0
                    ? Number(
                        (
                            notasTurma.reduce(
                                (total, nota) =>
                                    total + Number(nota.nota || 0),
                                0
                            ) / notasTurma.length
                        ).toFixed(2)
                    )
                    : 0;

            const representante = representantes.find(
                item =>
                    Number(item.turma_id) === Number(turma.id)
            );

            return {
                ...turma,

                totalAlunos: alunosTurma.length,

                frequenciaMedia,

                notaMedia,

                totalAdvertencias:
                    advertenciasTurma.length,

                totalChamadas:
                    chamadasTurma.length,

                representante: representante || null
            };
        });

        // -------------------------------------------------
        // DADOS GERAIS DA ESCOLA
        // -------------------------------------------------

        const alunosComChamada = alunos
            .map(aluno => {

                const registros = chamadas.filter(
                    chamada =>
                        Number(chamada.aluno_id) === Number(aluno.id)
                );

                return calcularFrequencia(
                    registros,
                    100
                );
            })
            .filter(
                dados =>
                    dados.totalDias > 0
            );

        const frequenciaGeral =
            alunosComChamada.length > 0
                ? Number(
                    (
                        alunosComChamada.reduce(
                            (total, dados) =>
                                total + dados.frequencia,
                            0
                        ) / alunosComChamada.length
                    ).toFixed(2)
                )
                : 0;

        const notaMediaGeral =
            notas.length > 0
                ? Number(
                    (
                        notas.reduce(
                            (total, nota) =>
                                total + Number(nota.nota || 0),
                            0
                        ) / notas.length
                    ).toFixed(2)
                )
                : 0;

        res.json({
            sucesso: true,

            escola: {
                totalTurmas: turmas.length,
                totalAlunos: alunos.length,
                totalRepresentantes: representantes.length,

                representantesAtivos:
                    representantes.filter(
                        representante =>
                            Number(representante.ativo) === 1
                    ).length,

                representantesInativos:
                    representantes.filter(
                        representante =>
                            Number(representante.ativo) !== 1
                    ).length,

                frequenciaMedia:
                    frequenciaGeral,

                notaMedia:
                    notaMediaGeral,

                totalAdvertencias:
                    advertencias.length,

                totalChamadas:
                    chamadas.length
            },

            turmas: turmasComDados,

            representantes
        });

    } catch (erro) {

        console.error(
            "Erro no painel administrativo:",
            erro
        );

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar dados administrativos."
        });
    }
});


// -----------------------------------------------------
// DADOS COMPLETOS DE UMA TURMA PARA O ADM
// -----------------------------------------------------

app.get("/api/admin/turma/:turmaId", async (req, res) => {

    try {

        const turmaId = Number(req.params.turmaId);

        if (!turmaId) {
            return res.status(400).json({
                sucesso: false,
                erro: "Turma inválida."
            });
        }

        const dados = await consultarUm(`
            SELECT *
            FROM turmas
            WHERE id = ?
        `, [turmaId]);

        if (!dados) {
            return res.status(404).json({
                sucesso: false,
                erro: "Turma não encontrada."
            });
        }

        const alunos = await consultar(`
            SELECT *
            FROM alunos
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        const disciplinas = await consultar(`
            SELECT *
            FROM disciplinas
            WHERE turma_id = ?
            ORDER BY nome ASC
        `, [turmaId]);

        const notas = await consultar(`
            SELECT
                notas.*,
                alunos.nome AS aluno_nome,
                disciplinas.nome AS disciplina_nome
            FROM notas
            INNER JOIN alunos
                ON alunos.id = notas.aluno_id
            LEFT JOIN disciplinas
                ON disciplinas.id = notas.disciplina_id
            WHERE alunos.turma_id = ?
            ORDER BY alunos.nome ASC
        `, [turmaId]);

        const chamadas = await consultar(`
            SELECT
                chamadas.*,
                alunos.nome AS aluno_nome
            FROM chamadas
            INNER JOIN alunos
                ON alunos.id = chamadas.aluno_id
            WHERE alunos.turma_id = ?
            AND chamadas.disciplina_id IS NULL
            ORDER BY chamadas.data DESC
        `, [turmaId]);

        const advertencias = await consultar(`
            SELECT
                advertencias.*,
                alunos.nome AS aluno_nome
            FROM advertencias
            INNER JOIN alunos
                ON alunos.id = advertencias.aluno_id
            WHERE alunos.turma_id = ?
            ORDER BY advertencias.data DESC
        `, [turmaId]);

        const representante = await consultarUm(`
            SELECT
                id,
                nome,
                usuario,
                turma_id,
                ativo,
                criado_em
            FROM representantes
            WHERE turma_id = ?
            LIMIT 1
        `, [turmaId]);

        res.json({
            sucesso: true,
            turma: dados,
            representante,
            alunos,
            disciplinas,
            notas,
            chamadas,
            advertencias
        });

    } catch (erro) {

        console.error(
            "Erro ao carregar turma administrativa:",
            erro
        );

        res.status(500).json({
            sucesso: false,
            erro: "Erro ao carregar dados da turma."
        });
    }
});

// =====================================================
// PÁGINAS
// =====================================================

app.get("/", (req, res) => {
    res.sendFile(
        path.join(pastaPublica, "index.html")
    );
});

app.get("/login.html", (req, res) => {
    res.sendFile(
        path.join(pastaPublica, "login.html")
    );
});

app.get("/index.html", (req, res) => {
    res.sendFile(
        path.join(pastaPublica, "index.html")
    );
});

// =====================================================
// 404 PARA API
// =====================================================

app.use("/api", (req, res) => {

    res.status(404).json({
        sucesso: false,
        erro: "Rota da API não encontrada.",
        rota: req.method + " " + req.originalUrl
    });
});

// =====================================================
// ERRO GERAL
// =====================================================

app.use((erro, req, res, next) => {

    console.error(
        "ERRO GERAL:",
        erro
    );

    if (res.headersSent) {
        return next(erro);
    }

    res.status(500).json({
        sucesso: false,
        erro: "Erro interno do servidor."
    });
});

// =====================================================
// USUÁRIO DE TESTE
// =====================================================

db.serialize(() => {

    db.get(`
        SELECT id
        FROM representantes
        WHERE usuario = 'gustavo'
    `, [], (erro, usuario) => {

        if (erro) {
            console.error(
                "Erro ao verificar usuário de teste:",
                erro.message
            );
            return;
        }

        if (!usuario) {

            db.run(`
                INSERT INTO representantes
                (
                    nome,
                    usuario,
                    senha,
                    primeiro_acesso,
                    ativo,
                    criado_em
                )
                VALUES (?, ?, ?, 1, 1, ?)
            `, [
                "Gustavo",
                "gustavo",
                "1234",
                new Date().toISOString()
            ], (erro) => {

                if (erro) {
                    console.error(
                        "Erro ao criar usuário de teste:",
                        erro.message
                    );
                } else {
                    console.log(
                        "Usuário de teste criado."
                    );
                }
            });

        } else {

            console.log(
                "Usuário de teste já existe."
            );
        }
    });
});

// =====================================================
// SERVIDOR
// =====================================================

app.listen(PORT, () => {

    console.log("");
    console.log("---------------------------------------");
    console.log(" SISTEMA DE REPRESENTANTES DE TURMA");
    console.log("---------------------------------------");
    console.log(
        `Servidor: http://localhost:${PORT}`
    );
    console.log(
        `Banco: ${caminhoBanco}`
    );
    console.log("---------------------------------------");
});