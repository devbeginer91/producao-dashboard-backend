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
    console.warn(`[formatDateToLocalISO - ${context}] Data inválida detectada, usando data atual:`, date);
    return new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 19);
  }
  const isoString = d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 19);
  console.log(`[formatDateToLocalISO - ${context}] Data capturada: ${d.toString()}, Data formatada: ${isoString}`);
  return isoString;
};

const calcularTempo = (inicio, fim = formatDateToLocalISO(new Date())) => {
  const inicioDate = new Date(inicio);
  const fimDate = new Date(fim);
  if (isNaN(inicioDate) || isNaN(fimDate)) {
    console.warn('Data inválida em calcularTempo:', { inicio, fim });
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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body:`, req.body);
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
    console.log('Conectado ao banco PostgreSQL');
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
    console.log('Tabela pedidos verificada/criada');

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
    console.log('Tabela itens_pedidos verificada/criada');

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
    console.log('Tabela historico_entregas verificada/criada');
  } catch (err) {
    console.error('Erro ao inicializar o banco:', err.message);
  }
};

const converterFormatoData = (dataInput) => {
  if (!dataInput || typeof dataInput !== 'string' || dataInput.includes('undefined')) {
    console.warn('Data inválida fornecida, usando data atual:', dataInput);
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

  console.warn('Formato de data não reconhecido, usando data atual:', dataInput);
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
};

const montarEmail = (pedido, itens, observacao) => {
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
    ${pedido.peso || pedido.volume ? `- Peso: ${pedido.peso || 'Não informado'}\n- Volume: ${pedido.volume || 'Não informado'}` : ''}
    - Pausado: ${pedido.pausado ? 'Sim' : 'Não'}
    - Tempo Pausado (min): ${pedido.tempoPausado || 0}
    Itens:
    ${itens.map(item => `- Código: ${item.codigoDesenho}, Qtd Pedida: ${item.quantidadePedido}, Qtd Entregue: ${item.quantidadeEntregue}`).join('\n')}
  `;
  const observacaoText = observacao ? `${observacao}\n\n` : '';
  return `${observacaoText}${detalhesPedido}`.trim();
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
        const tempoDecorrido = calcularTempo(dataReferencia, formatDateToLocalISO(new Date(), `fetchPedidos - pedido ${pedido.id}`));
        tempoFinal = tempoPausado + tempoDecorrido;
      }
      console.log(`GET /pedidos - pedido ${pedido.id}: tempoFinal = ${tempoFinal}, tempoPausado = ${tempoPausado}, pausado = ${pedido.pausado}, inicio = ${pedido.inicio}, dataPausada = ${pedido.datapausada}`);
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
    console.log('Pedidos retornados:', pedidosComItens);
    res.json(pedidosComItens);
  } catch (err) {
    console.error('Erro ao listar pedidos:', err.message);
    res.status(500).json({ message: 'Erro ao listar pedidos', error: err.message });
  }
});

app.get('/historico-entregas/:pedidoId', async (req, res) => {
  const pedidoId = parseInt(req.params.pedidoId);
  try {
    const historico = await db.all('SELECT * FROM historico_entregas WHERE pedido_id = $1', [pedidoId]);
    console.log(`GET /historico-entregas/${pedidoId} - Histórico retornado:`, historico);
    res.json(historico);
  } catch (error) {
    console.error(`Erro ao buscar histórico para pedido ${pedidoId}:`, error.message);
    res.status(500).json({ message: 'Erro ao buscar histórico', error: error.message });
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

  console.log('Dados recebidos no PUT /pedidos:', { id, empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status });

  const inicioFormatado = converterFormatoData(inicio);
  const dataConclusaoFormatada = status === 'concluido' && !dataConclusao
    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : dataConclusao ? converterFormatoData(dataConclusao) : null;
  const dataPausadaFormatada = dataPausada ? converterFormatoData(dataPausada) : null;
  const dataInicioPausaFormatada = dataInicioPausa ? converterFormatoData(dataInicioPausa) : null;

  const tempoFinal = pausado === '1' ? Number(tempoPausado) : Number(tempo);

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

  try {
    console.log('Atualizando pedido com valores:', pedidoValues);
    const result = await pool.query(pedidoSql, pedidoValues);
    if (result.rowCount === 0) {
      console.error('Pedido não encontrado:', id);
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }

    console.log('Deletando itens antigos para pedido_id:', id);
    await pool.query('DELETE FROM itens_pedidos WHERE pedido_id = $1', [id]);

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
    const totalItens = itens ? itens.length : 0;

    if (totalItens > 0) {
      for (const item of itens) {
        const { codigoDesenho, quantidadePedido, quantidadeEntregue } = item;
        console.log('Inserindo item:', { pedido_id: id, codigoDesenho, quantidadePedido, quantidadeEntregue });
        const itemResult = await pool.query(itemSql, [id, codigoDesenho, quantidadePedido, quantidadeEntregue || 0]);
        const itemId = itemResult.rows[0].id;
        if (quantidadeEntregue > 0) {
          const dataEdicao = formatDateToLocalISO(new Date(), 'historico');
          console.log('Tentando inserir no histórico:', { pedido_id: id, item_id: itemId, quantidadeEntregue, dataEdicao });
          const historicoResult = await pool.query(historicoSql, [id, itemId, quantidadeEntregue, dataEdicao]);
          console.log('Registro inserido no histórico:', historicoResult.rows[0]);
        } else {
          console.log('Quantidade entregue é 0, pulando inserção no histórico para item:', itemId);
        }
      }
      console.log(`Todos os ${totalItens} itens atualizados com sucesso`);
    }

    const pedidoAtualizado = { 
      id, 
      empresa, 
      numeroOS, 
      dataEntrada, 
      previsaoEntrega, 
      responsavel, 
      status, 
      inicio: inicioFormatado, 
      tempo: tempoFinal,
      peso, 
      volume, 
      dataConclusao: dataConclusaoFormatada, 
      pausado: pausado || 0, 
      tempoPausado: Number(tempoPausado) || 0, 
      dataPausada: dataPausadaFormatada, 
      dataInicioPausa: dataInicioPausaFormatada, 
      itens: itens ? itens.map(item => ({
        ...item,
        codigoDesenho: item.codigoDesenho || item.codigodesenho,
        quantidadePedido: item.quantidadePedido || item.quantidadepedido,
        quantidadeEntregue: item.quantidadeEntregue || item.quantidadeentregue
      })) : []
    };
    console.log('Pedido atualizado retornado:', pedidoAtualizado);
    res.json(pedidoAtualizado);
  } catch (error) {
    console.error('Erro ao atualizar pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao atualizar pedido', error: error.message, stack: error.stack });
  }
});

app.delete('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    console.log('Deletando pedido com id:', id);
    const result = await pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      console.error('Pedido não encontrado para exclusão:', id);
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }
    console.log('Pedido excluído:', id);
    res.status(204).send();
  } catch (error) {
    console.error('Erro ao excluir pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao excluir pedido', error: error.message, stack: error.stack });
  }
});

app.post('/pedidos', async (req, res) => {
  const { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, itens } = req.body;

  console.log('Dados recebidos no POST /pedidos:', { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status });

  if (!empresa || !numeroOS || !dataEntrada || !previsaoEntrega || !status || !inicio || !Array.isArray(itens) || itens.length === 0) {
    console.error('Campos obrigatórios ausentes ou itens inválidos:', req.body);
    return res.status(400).json({ message: 'Campos obrigatórios ausentes ou itens inválidos' });
  }

  for (const item of itens) {
    if (!item.codigoDesenho || item.codigoDesenho.trim() === '' || item.quantidadePedido === undefined || item.quantidadePedido === null || item.quantidadePedido === '') {
      console.error('Item inválido:', item);
      return res.status(400).json({ message: 'Todos os itens devem ter código e quantidade pedida válidos' });
    }
    item.quantidadePedido = parseInt(item.quantidadePedido, 10);
    item.quantidadeEntregue = parseInt(item.quantidadeEntregue || 0, 10);
    if (isNaN(item.quantidadePedido) || item.quantidadePedido < 0) {
      console.error('Quantidade pedida inválida:', item);
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

  try {
    console.log('Inserindo pedido principal com valores:', pedidoValues);
    const result = await pool.query(pedidoSql, pedidoValues);
    const pedidoId = result.rows[0].id;
    console.log('Pedido inserido com ID:', pedidoId);

    const itemSql = `
      INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue)
      VALUES ($1, $2, $3, $4)
    `;
    const totalItens = itens.length;

    for (const item of itens) {
      const { codigoDesenho, quantidadePedido, quantidadeEntregue } = item;
      console.log('Inserindo item:', { pedido_id: pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue });
      await pool.query(itemSql, [pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue || 0]);
    }
    console.log(`Todos os ${totalItens} itens inseridos com sucesso`);

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
    console.log('Novo pedido retornado:', novoPedido);
    res.status(201).json(novoPedido);
  } catch (error) {
    console.error('Erro ao processar pedido:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao processar pedido', error: error.message, stack: error.stack });
  }
});

app.post('/enviar-email', async (req, res) => {
  const { pedido, observacao } = req.body;

  console.log('Dados recebidos no POST /enviar-email:', { pedido, observacao });

  if (!pedido || !pedido.numeroOS) {
    console.error('Erro: Nenhum pedido ou numeroOS fornecido para envio de e-mail');
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

  const mailOptions = {
    from: process.env.EMAIL_USER || 'dcashopecia@gmail.com',
    to: process.env.EMAIL_TO || 'danielalves@dcachicoteseletricos.com.br',
    subject,
    text: montarEmail(pedidoFormatado, pedidoFormatado.itens || [], observacao),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('E-mail enviado:', info.response);
    res.status(200).json({ message: 'E-mail enviado com sucesso' });
  } catch (error) {
    console.error('Erro ao enviar e-mail:', error.message, 'Stack:', error.stack);
    res.status(500).json({ message: 'Erro ao enviar e-mail', error: error.message, stack: error.stack });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});