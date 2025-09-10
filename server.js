const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 5000;

const formatDateToLocalISO = (date, context = 'unknown') => {
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime()) || (typeof date === 'string' && date.includes('undefined'))) {
    return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 19);
  }
  return d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 19);
};

const calcularTempo = (inicio, fim = formatDateToLocalISO(new Date())) => {
  const inicioDate = new Date(inicio);
  const fimDate = new Date(fim);
  if (isNaN(inicioDate) || isNaN(fimDate)) {
    return 0;
  }
  const diffMs = fimDate - inicioDate;
  return diffMs < 0 ? 0 : Math.round(diffMs / (1000 * 60));
};

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://producao-dashboard-backend.onrender.com ws://producao-dashboard-frontend.onrender.com"
  );
  next();
});

app.use(cors({
  origin: 'https://producao-dashboard-frontend.onrender.com',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Backend do Controle de Produção está ativo! Acesse a API em /pedidos ou o frontend em /dashboard.');
});

app.use((req, res, next) => {
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://producao_dashboard_db_user:CiMFfDpnp8etmNOPpgVVELSwzTtHeJ12@dpg-cvc5vl3tq21c73dlt630-a.oregon-postgres.render.com/producao_dashboard_db',
  ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
  if (err) {
    console.error('Erro ao conectar ao PostgreSQL:', err.message);
    process.exit(1);
  } else {
    initializeDatabase();
  }
});

const db = {
  run: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve({ lastID: result.rows[0]?.id, changes: result.rowCount });
      });
    });
  },
  get: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result.rows[0]);
      });
    });
  },
  all: (sql, params = []) => {
    return new Promise((resolve, reject) => {
      pool.query(sql, params, (err, result) => {
        if (err) reject(err);
        else resolve(result.rows);
      });
    });
  }
};

const initializeDatabase = async () => {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        empresa TEXT NOT NULL,
        numeroOS TEXT NOT NULL,
        dataEntrada TEXT NOT NULL,
        previsaoEntrega TEXT NOT NULL,
        responsavel TEXT,
        status TEXT NOT NULL,
        inicio TEXT NOT NULL,
        tempo FLOAT DEFAULT 0,
        peso FLOAT,
        volume FLOAT,
        dataConclusao TEXT,
        pausado INTEGER DEFAULT 0,
        tempoPausado FLOAT DEFAULT 0,
        dataPausada TEXT,
        dataInicioPausa TEXT
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS itens_pedidos (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER,
        codigoDesenho TEXT NOT NULL,
        quantidadePedido INTEGER NOT NULL,
        quantidadeEntregue INTEGER DEFAULT 0,
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS historico_entregas (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER,
        item_id INTEGER,
        quantidadeEntregue INTEGER NOT NULL,
        dataEdicao TEXT NOT NULL,
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
        FOREIGN KEY (item_id) REFERENCES itens_pedidos(id) ON DELETE CASCADE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS historico_observacoes (
        id SERIAL PRIMARY KEY,
        pedido_id INTEGER,
        observacao TEXT NOT NULL,
        dataEdicao TEXT NOT NULL,
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
      )
    `);
  } catch (err) {
    console.error('Erro ao inicializar o banco:', err.message);
  }
};

const converterFormatoData = (dataInput) => {
  if (!dataInput || typeof dataInput !== 'string' || dataInput.includes('undefined')) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  const isoFormatRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (isoFormatRegex.test(dataInput)) {
    const parsedDate = new Date(dataInput);
    if (!isNaN(parsedDate)) {
      return dataInput;
    }
  }

  const parsedDate = new Date(dataInput);
  if (!isNaN(parsedDate)) {
    return parsedDate.toISOString().slice(0, 19).replace('T', ' ');
  }

  return new Date().toISOString().slice(0, 19).replace('T', ' ');
};

const montarEmail = (pedido, itens, observacao, quantidadesEditadas) => {
  const detalhesPedido = `
    Detalhes do Pedido:
    - Empresa: ${pedido.empresa || 'Não informado'}
    - Número da OS: ${pedido.numeroOS || 'Não informado'}
    - Data de Entrada: ${pedido.dataEntrada ? new Date(pedido.dataEntrada).toLocaleDateString('pt-BR') : 'Não informado'}
    - Previsão de Entrega: ${pedido.previsaoEntrega ? new Date(pedido.previsaoEntrega).toLocaleDateString('pt-BR') : 'Não informado'}
    - Responsável: ${pedido.responsavel || 'Não informado'}
    - Status: ${pedido.status || 'Não informado'}
    - Início: ${pedido.inicio}
    ${pedido.dataConclusao ? `- Conclusão: ${pedido.dataConclusao}` : ''}
    - Tempo (min): ${pedido.tempo || 0}
    - Pausado: ${pedido.pausado ? 'Sim' : 'Não'}
    - Tempo Pausado (min): ${pedido.tempoPausado || 0}
    Itens:
    ${itens.map(item => `- Código: ${item.codigoDesenho}, Qtd Pedida: ${item.quantidadePedido}, Qtd Entregue: ${item.quantidadeEntregue}, Saldo: ${item.quantidadePedido - item.quantidadeEntregue}`).join('\n')}
  `;

  const quantidadesEditadasText = quantidadesEditadas && quantidadesEditadas.length > 0 ? `
    Quantidade Editada:
    ${quantidadesEditadas.map(edit => `- Código: ${edit.codigoDesenho}, QTD: ${edit.quantidade}, Peso: ${pedido.peso || 'Não informado'}, Volume: ${pedido.volume || 'Não informado'}`).join('\n')}
  ` : '';

  const observacaoText = observacao ? `${observacao}\n\n` : '';
  return `${observacaoText}${detalhesPedido}${quantidadesEditadasText}`.trim();
};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'dcashopecia@gmail.com',
    pass: process.env.EMAIL_PASS || 'swxr dcjg xudk tcdz',
  },
});

app.get('/pedidos', async (req, res) => {
  try {
    const pedidos = await db.all('SELECT * FROM pedidos');
    const itens = await db.all('SELECT * FROM itens_pedidos');
    const pedidosComItens = pedidos.map(pedido => {
      const tempoPausado = Number(pedido.tempopausado) || 0;
      let tempoFinal = tempoPausado;
      if (pedido.status === 'concluido') {
        tempoFinal = Number(pedido.tempo) || 0;
      } else if (pedido.status === 'andamento' && pedido.pausado !== '1') {
        const dataReferencia = pedido.datapausada || pedido.inicio;
        const tempoDecorrido = calcularTempo(dataReferencia, formatDateToLocalISO(new Date()));
        tempoFinal = tempoPausado + tempoDecorrido;
      }
      return {
        ...pedido,
        numeroOS: pedido.numeroos,
        dataEntrada: pedido.dataentrada,
        previsaoEntrega: pedido.previsaoentrega,
        dataConclusao: pedido.dataconclusao,
        dataPausada: pedido.datapausada,
        dataInicioPausa: pedido.datainiciopausa,
        inicio: converterFormatoData(pedido.inicio),
        dataConclusao: pedido.dataconclusao ? converterFormatoData(pedido.dataconclusao) : null,
        dataPausada: pedido.datapausada ? converterFormatoData(pedido.datapausada) : null,
        dataInicioPausa: pedido.datainiciopausa ? converterFormatoData(pedido.datainiciopausa) : null,
        tempo: tempoFinal,
        tempoPausado: tempoPausado,
        pausado: pedido.pausado ? pedido.pausado.toString() : '0',
        itens: itens.filter(item => item.pedido_id === pedido.id).map(item => ({
          ...item,
          codigoDesenho: item.codigodesenho,
          quantidadePedido: item.quantidadepedido,
          quantidadeEntregue: item.quantidadeentregue
        }))
      };
    });
    res.json(pedidosComItens);
  } catch (err) {
    console.error('Erro ao listar pedidos:', err.message);
    res.status(500).json({ message: 'Erro ao listar pedidos', error: err.message });
  }
});

app.get('/historico-entregas/:pedidoId', async (req, res) => {
  const pedidoId = parseInt(req.params.pedidoId);
  try {
    const historico = await db.all(`
      SELECT h.*, i.codigoDesenho 
      FROM historico_entregas h 
      LEFT JOIN itens_pedidos i ON h.item_id = i.id 
      WHERE h.pedido_id = $1
      ORDER BY h.dataEdicao ASC
    `, [pedidoId]);
    console.log(`GET /historico-entregas/${pedidoId} - Dados retornados:`, historico);
    res.json(historico);
  } catch (error) {
    console.error(`Erro ao buscar histórico para pedido ${pedidoId}:`, error.message);
    res.status(500).json({ message: 'Erro ao buscar histórico', error: error.message });
  }
});

app.put('/historico-entregas/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { quantidadeEntregue } = req.body;

  if (quantidadeEntregue === undefined || quantidadeEntregue < 0) {
    return res.status(400).json({ message: 'Quantidade entregue deve ser um número não negativo' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const historicoResult = await client.query('SELECT * FROM historico_entregas WHERE id = $1', [id]);
    if (historicoResult.rows.length === 0) {
      throw new Error('Entrada de entrega não encontrada');
    }
    const historicoEntry = historicoResult.rows[0];
    const itemId = historicoEntry.item_id;
    const pedidoId = historicoEntry.pedido_id;

    const dataEdicao = formatDateToLocalISO(new Date(), 'edit_historico_entrega');
    const updateResult = await client.query(
      'UPDATE historico_entregas SET quantidadeEntregue = $1, dataEdicao = $2 WHERE id = $3 RETURNING *',
      [quantidadeEntregue, dataEdicao, id]
    );
    const updatedEntry = updateResult.rows[0];

    const historicoTotalResult = await client.query(
      'SELECT SUM(quantidadeEntregue) as total FROM historico_entregas WHERE item_id = $1',
      [itemId]
    );
    const totalEntregue = parseInt(historicoTotalResult.rows[0].total, 10) || 0;

    await client.query(
      'UPDATE itens_pedidos SET quantidadeEntregue = $1 WHERE id = $2',
      [totalEntregue, itemId]
    );

    const itemResult = await client.query('SELECT codigoDesenho FROM itens_pedidos WHERE id = $1', [itemId]);
    const codigoDesenho = itemResult.rows[0]?.codigodesenho || 'Desconhecido';

    await client.query('COMMIT');

    const responseData = {
      ...updatedEntry,
      codigoDesenho
    };
    console.log(`PUT /historico-entregas/${id} - Dados retornados ao frontend:`, responseData);
    res.status(200).json(responseData);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao editar entrada de entrega:', error.message);
    res.status(500).json({ message: 'Erro ao editar entrada de entrega', error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/historico-entregas/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const historicoResult = await client.query('SELECT * FROM historico_entregas WHERE id = $1', [id]);
    if (historicoResult.rows.length === 0) {
      throw new Error('Entrada de entrega não encontrada');
    }
    const historicoEntry = historicoResult.rows[0];
    const itemId = historicoEntry.item_id;

    console.log(`DELETE /historico-entregas/${id} - Excluindo entrada do histórico:`, historicoEntry);

    const deleteResult = await client.query('DELETE FROM historico_entregas WHERE id = $1 RETURNING *', [id]);
    if (deleteResult.rowCount === 0) {
      throw new Error('Entrada de entrega não encontrada');
    }

    const historicoTotalResult = await client.query(
      'SELECT SUM(quantidadeEntregue) as total FROM historico_entregas WHERE item_id = $1',
      [itemId]
    );
    const totalEntregue = parseInt(historicoTotalResult.rows[0].total, 10) || 0;

    await client.query(
      'UPDATE itens_pedidos SET quantidadeEntregue = $1 WHERE id = $2',
      [totalEntregue, itemId]
    );

    await client.query('COMMIT');

    res.status(204).send();
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao excluir entrada de entrega:', error.message);
    res.status(500).json({ message: 'Erro ao excluir entrada de entrega', error: error.message });
  } finally {
    client.release();
  }
});

app.get('/historico-observacoes/:pedidoId', async (req, res) => {
  const pedidoId = parseInt(req.params.pedidoId);
  try {
    const historico = await db.all(`
      SELECT id, pedido_id, observacao, dataEdicao 
      FROM historico_observacoes 
      WHERE pedido_id = $1
      ORDER BY dataEdicao ASC
    `, [pedidoId]);
    const historicoFormatado = historico.map(entry => ({
      id: entry.id,
      pedido_id: entry.pedido_id,
      observacao: entry.observacao,
      dataEdicao: entry.dataedicao ? converterFormatoData(entry.dataedicao) : null
    }));
    res.json(historicoFormatado || []);
  } catch (error) {
    console.error(`Erro ao buscar histórico de observações para pedido ${pedidoId}:`, error.message);
    res.status(500).json({ message: 'Erro ao buscar histórico de observações', error: error.message });
  }
});

app.put('/historico-observacoes/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { observacao } = req.body;

  if (!observacao || observacao.trim() === '') {
    return res.status(400).json({ message: 'Observação não pode ser vazia' });
  }

  try {
    const dataEdicao = formatDateToLocalISO(new Date(), 'edit_observacao');
    const result = await pool.query(
      'UPDATE historico_observacoes SET observacao = $1, dataEdicao = $2 WHERE id = $3 RETURNING *',
      [observacao.trim(), dataEdicao, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Observação não encontrada' });
    }
    const updatedEntry = result.rows[0];
    res.status(200).json({
      id: updatedEntry.id,
      pedido_id: updatedEntry.pedido_id,
      observacao: updatedEntry.observacao,
      dataEdicao: updatedEntry.dataedicao ? converterFormatoData(updatedEntry.dataedicao) : null
    });
  } catch (error) {
    console.error('Erro ao editar observação:', error.message);
    res.status(500).json({ message: 'Erro ao editar observação', error: error.message });
  }
});

app.delete('/historico-observacoes/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const result = await pool.query('DELETE FROM historico_observacoes WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Observação não encontrada' });
    }
    res.status(200).json({ message: 'Observação excluída com sucesso' });
  } catch (error) {
    console.error('Erro ao excluir observação:', error.message);
    res.status(500).json({ message: 'Erro ao excluir observação', error: error.message });
  }
});

app.put('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { 
    empresa, 
    numeroOS,
    dataEntrada,
    previsaoEntrega,
    responsavel, 
    status, 
    inicio, 
    tempo, 
    peso, 
    volume, 
    dataConclusao, 
    pausado, 
    tempoPausado, 
    dataPausada, 
    dataInicioPausa, 
    itens 
  } = req.body;

  const inicioFormatado = converterFormatoData(inicio);
  const dataConclusaoFormatada = status === 'concluido' && !dataConclusao
    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : dataConclusao ? converterFormatoData(dataConclusao) : null;
  const dataPausadaFormatada = dataPausada ? converterFormatoData(dataPausada) : null;
  const dataInicioPausaFormatada = dataInicioPausa ? converterFormatoData(dataInicioPausa) : null;

  const tempoFinal = pausado === '1' ? Number(tempoPausado) : Number(tempo);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const pedidoSql = `
      UPDATE pedidos SET
        empresa = $1,
        numeroOS = $2,
        dataEntrada = $3,
        previsaoEntrega = $4,
        responsavel = $5,
        status = $6,
        inicio = $7,
        tempo = $8,
        peso = $9,
        volume = $10,
        dataConclusao = $11,
        pausado = $12,
        tempoPausado = $13,
        dataPausada = $14,
        dataInicioPausa = $15
      WHERE id = $16
      RETURNING *
    `;
    const pedidoValues = [
      empresa || null,
      numeroOS || null,
      dataEntrada || null,
      previsaoEntrega || null,
      responsavel || null,
      status,
      inicioFormatado,
      tempoFinal,
      peso || null,
      volume || null,
      dataConclusaoFormatada,
      pausado || 0,
      Number(tempoPausado) || 0,
      dataPausadaFormatada,
      dataInicioPausaFormatada,
      id
    ];

    const result = await client.query(pedidoSql, pedidoValues);
    if (result.rows.length === 0) {
      throw new Error('Pedido não encontrado');
    }
    const pedidoAtualizado = result.rows[0];

    if (status === 'concluido') {
      const updateItensSql = `
        UPDATE itens_pedidos
        SET quantidadeEntregue = quantidadePedido
        WHERE pedido_id = $1
        RETURNING *
      `;
      const itensResult = await client.query(updateItensSql, [id]);

      const historicoSql = `
        INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
      const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
      for (const item of itensResult.rows) {
        const quantidadeEntregue = item.quantidadepedido;
        if (quantidadeEntregue > 0) {
          await client.query(historicoSql, [id, item.id, quantidadeEntregue, dataEdicao]);
        }
      }
    }

    if (itens && Array.isArray(itens)) {
      const itensExistentes = await client.query('SELECT * FROM itens_pedidos WHERE pedido_id = $1', [id]);
      const itensExistentesMap = new Map(itensExistentes.rows.map(item => [item.codigodesenho, item]));

      const itemSql = `
        UPDATE itens_pedidos
        SET codigoDesenho = $1, quantidadePedido = $2, quantidadeEntregue = $3
        WHERE pedido_id = $4 AND id = $5
        RETURNING *
      `;
      const insertItemSql = `
        INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;
      const historicoSql = `
        INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `;

      for (const item of itens) {
        const { id: itemId, codigoDesenho, quantidadePedido, quantidadeEntregue } = item;
        let updatedItem;
        const itemExistente = itensExistentesMap.get(codigoDesenho);
        if (itemExistente) {
          const quantidadeEntregueAnterior = itemExistente.quantidadeentregue || 0;
          const novaQuantidadeEntregue = parseInt(quantidadeEntregue || 0, 10);
          const quantidadeAdicionada = novaQuantidadeEntregue - quantidadeEntregueAnterior;

          const itemResult = await client.query(itemSql, [
            codigoDesenho,
            quantidadePedido,
            novaQuantidadeEntregue,
            id,
            itemExistente.id
          ]);
          updatedItem = itemResult.rows[0];

          if (quantidadeAdicionada > 0) {
            const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
            await client.query(historicoSql, [
              id,
              updatedItem.id,
              quantidadeAdicionada,
              dataEdicao
            ]);
          }
        } else {
          const itemResult = await client.query(insertItemSql, [
            id,
            codigoDesenho,
            quantidadePedido,
            quantidadeEntregue || 0
          ]);
          updatedItem = itemResult.rows[0];

          if (quantidadeEntregue > 0) {
            const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
            await client.query(historicoSql, [
              id,
              updatedItem.id,
              quantidadeEntregue,
              dataEdicao
            ]);
          }
        }
      }

      const codigosEnviados = new Set(itens.map(item => item.codigoDesenho));
      for (const itemExistente of itensExistentes.rows) {
        if (!codigosEnviados.has(itemExistente.codigodesenho)) {
          console.log(`PUT /pedidos/${id} - Excluindo item ${itemExistente.id} (código: ${itemExistente.codigodesenho}) do pedido ${id}, pois não está mais na lista.`);
          await client.query('DELETE FROM itens_pedidos WHERE id = $1', [itemExistente.id]);
        }
      }
    }

    await client.query('COMMIT');

    const itensSql = 'SELECT * FROM itens_pedidos WHERE pedido_id = $1';
    const itensResult = await client.query(itensSql, [id]);
    const pedidoComItens = { 
      ...pedidoAtualizado, 
      numeroOS: pedidoAtualizado.numeroos,
      dataEntrada: pedidoAtualizado.dataentrada,
      previsaoEntrega: pedidoAtualizado.previsaoentrega,
      dataConclusao: pedidoAtualizado.dataconclusao,
      dataPausada: pedidoAtualizado.datapausada,
      dataInicioPausa: pedidoAtualizado.datainiciopausa,
      tempo: tempoFinal,
      tempoPausado: Number(tempoPausado) || 0,
      pausado: pausado || '0',
      itens: itensResult.rows.map(item => ({
        ...item,
        codigoDesenho: item.codigodesenho,
        quantidadePedido: item.quantidadepedido,
        quantidadeEntregue: item.quantidadeentregue
      }))
    };

    res.status(200).json(pedidoComItens);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao atualizar pedido', error: error.message, stack: error.stack });
  } finally {
    client.release();
  }
});

app.delete('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const result = await pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Erro ao excluir pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao excluir pedido', error: error.message, stack: error.stack });
  }
});

app.post('/pedidos', async (req, res) => {
  const { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, itens } = req.body;

  if (!empresa || !numeroOS || !dataEntrada || !previsaoEntrega || !status || !inicio || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ message: 'Campos obrigatórios ausentes ou itens inválidos' });
  }

  for (const item of itens) {
    if (!item.codigoDesenho || item.codigoDesenho.trim() === '' || item.quantidadePedido === undefined || item.quantidadePedido === null || item.quantidadePedido === '') {
      return res.status(400).json({ message: 'Todos os itens devem ter código e quantidade pedida válidos' });
    }
    item.quantidadePedido = parseInt(item.quantidadePedido, 10);
    item.quantidadeEntregue = parseInt(item.quantidadeEntregue || 0, 10);
    if (isNaN(item.quantidadePedido) || item.quantidadePedido < 0) {
      return res.status(400).json({ message: 'Quantidade pedida deve ser um número positivo' });
    }
  }

  const inicioFormatado = converterFormatoData(inicio);

  const pedidoSql = `
    INSERT INTO pedidos (empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, tempo, tempoPausado, pausado)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0)
    RETURNING id
  `;
  const pedidoValues = [empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel || null, status, inicioFormatado];

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(pedidoSql, pedidoValues);
    const pedidoId = result.rows[0]?.id;
    if (!pedidoId) {
      throw new Error('Falha ao inserir pedido: ID não retornado');
    }

    const itemSql = `
      INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `;
    const historicoSql = `
      INSERT INTO historico_entregas (pedido_id, item_id, quantidadeEntregue, dataEdicao)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;

    for (const item of itens) {
      const { codigoDesenho, quantidadePedido, quantidadeEntregue } = item;
      const itemResult = await client.query(itemSql, [pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue || 0]);
      if (!itemResult.rows || itemResult.rows.length === 0) {
        throw new Error('Falha ao inserir item: Nenhum ID retornado');
      }
      const itemId = itemResult.rows[0].id;
      if (quantidadeEntregue > 0) {
        const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
        await client.query(historicoSql, [pedidoId, itemId, quantidadeEntregue, dataEdicao]);
      }
    }

    await client.query('COMMIT');

    const novoPedido = { 
      id: pedidoId, 
      empresa, 
      numeroOS, 
      dataEntrada, 
      previsaoEntrega, 
      responsavel, 
      status, 
      inicio: inicioFormatado, 
      tempo: 0, 
      tempoPausado: 0, 
      pausado: '0', 
      itens 
    };
    res.status(201).json(novoPedido);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erro ao processar pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao processar pedido', error: error.message, stack: error.stack });
  } finally {
    client.release();
  }
});

app.post('/enviar-email', async (req, res) => {
  const { pedido, observacao, quantidadesEditadas } = req.body;

  if (!pedido || !pedido.numeroOS) {
    return res.status(400).json({ message: 'Dados do pedido inválidos ou número da OS não fornecido' });
  }

  const pedidoFormatado = {
    ...pedido,
    inicio: converterFormatoData(pedido.inicio),
    dataConclusao: pedido.dataConclusao ? converterFormatoData(pedido.dataConclusao) : null,
  };

  const subject = observacao
    ? `Observação sobre Pedido ${pedidoFormatado.numeroOS}`
    : `Atualização de Pedido ${pedidoFormatado.numeroOS} - Status: ${pedidoFormatado.status || 'Desconhecido'}`;

  const emailText = montarEmail(pedidoFormatado, pedidoFormatado.itens || [], observacao, quantidadesEditadas);

  const rawEmailTo = (process.env.EMAIL_TO || 'dca@dcachicoteseletricos.com.br').replace(/\s+/g, '');
  const destinatarios = rawEmailTo
    .split(',')
    .map(email => email.trim())
    .filter(email => email.length > 0 && email.includes('@'));

  if (destinatarios.length === 0) {
    return res.status(400).json({ message: 'Nenhum destinatário válido encontrado em EMAIL_TO' });
  }

  try {
    for (const [index, destinatario] of destinatarios.entries()) {
      const mailOptions = {
        from: `"Controle de Produção" <${process.env.EMAIL_USER || 'dcashopecia@gmail.com'}>`,
        to: destinatario,
        subject,
        text: emailText,
      };
      await transporter.sendMail(mailOptions);
    }

    if (observacao && observacao.trim()) {
      const dataEdicao = formatDateToLocalISO(new Date(), 'historico_observacao');
      const observacaoSql = `
        INSERT INTO historico_observacoes (pedido_id, observacao, dataEdicao)
        VALUES ($1, $2, $3)
        RETURNING *
      `;
      await pool.query(observacaoSql, [pedido.id, observacao.trim(), dataEdicao]);
    }

    res.status(200).json({ message: 'E-mails enviados com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar e-mails:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao enviar e-mails', error: error.message, stack: error.stack });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});