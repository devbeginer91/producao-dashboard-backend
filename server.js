const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 5000;

// Função para formatar datas no formato YYYY-MM-DD HH:MM:SS com fuso horário America/Sao_Paulo (UTC-3)
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

// Função auxiliar para calcular tempo entre duas datas
const calcularTempo = (inicio, fim) => {
  const inicioDate = new Date(inicio);
  const fimDate = new Date(fim);
  if (isNaN(inicioDate) || isNaN(fimDate)) {
    console.error('Data inválida em calcularTempo:', { inicio, fim });
    return 0;
  }
  const diffMs = fimDate - inicioDate;
  return diffMs < 0 ? 0 : diffMs / (1000 * 60); // Retorna em minutos
};

// Middleware para Content-Security-Policy
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:5000 ws://localhost:3000");
  next();
});
app.use(cors());
app.use(express.json());

// Middleware para log de requisições
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Body:`, req.body);
  next();
});

// Conectar ao banco SQLite e inicializar tabelas
const db = new sqlite3.Database('pedidos.db', (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco:', err.message);
    process.exit(1); // Encerra o servidor se a conexão falhar
  } else {
    console.log('Conectado ao banco SQLite');
    initializeDatabase().then(() => startServer()).catch(err => {
      console.error('Erro ao inicializar o banco:', err.message);
      process.exit(1);
    });
  }
});

// Função para inicializar o banco de dados
const initializeDatabase = () => {
  return new Promise((resolve, reject) => {
    // Criar ou verificar a tabela pedidos com dataInicioPausa
    db.run(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        empresa TEXT NOT NULL,
        numeroOS TEXT NOT NULL,
        dataEntrada TEXT NOT NULL,
        previsaoEntrega TEXT NOT NULL,
        responsavel TEXT,
        status TEXT NOT NULL,
        inicio TEXT NOT NULL,
        tempo REAL DEFAULT 0,
        peso REAL,
        volume REAL,
        dataConclusao TEXT,
        pausado INTEGER DEFAULT 0,
        tempoPausado REAL DEFAULT 0,
        dataPausada TEXT,
        dataInicioPausa TEXT
      )
    `, (err) => {
      if (err) {
        console.error('Erro ao criar/verificar tabela pedidos:', err.message);
        reject(err);
      } else {
        console.log('Tabela pedidos verificada/criada');

        // Criar ou verificar a tabela itens_pedidos
        db.run(`
          CREATE TABLE IF NOT EXISTS itens_pedidos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pedido_id INTEGER,
            codigoDesenho TEXT NOT NULL,
            quantidadePedido INTEGER NOT NULL,
            quantidadeEntregue INTEGER DEFAULT 0,
            FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
          )
        `, (err) => {
          if (err) {
            console.error('Erro ao criar/verificar tabela itens_pedidos:', err.message);
            reject(err);
          } else {
            console.log('Tabela itens_pedidos verificada/criada');
            resolve();
          }
        });
      }
    });
  });
};

// Função para iniciar o servidor
const startServer = () => {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Porta ${PORT} já está em uso. Tentando liberar...`);
      require('child_process').exec(`netstat -aon | findstr :${PORT} | findstr LISTENING`, (error, stdout) => {
        if (stdout) {
          const pid = stdout.match(/\d+$/)[0];
          console.log(`Encerrando processo ${pid} na porta ${PORT}`);
          require('child_process').exec(`taskkill /PID ${pid} /F`, (err) => {
            if (err) {
              console.error('Falha ao encerrar processo:', err.message);
              process.exit(1);
            } else {
              console.log('Porta liberada, reiniciando servidor...');
              startServer(); // Tenta reiniciar o servidor
            }
          });
        } else {
          console.error('Nenhum processo encontrado na porta', PORT);
          process.exit(1);
        }
      });
    } else {
      console.error('Erro ao iniciar o servidor:', err.message);
      process.exit(1);
    }
  });
};

// Função para executar uma query SQLite como Promise
const runQuery = (sql, params) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
};

// Função para converter e validar formato de data para YYYY-MM-DD HH:MM:SS
const converterFormatoData = (dataInput) => {
  if (!dataInput || typeof dataInput !== 'string' || dataInput.includes('undefined')) {
    console.warn('Data inválida fornecida, usando data atual:', dataInput);
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }

  const isoFormatRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (isoFormatRegex.test(dataInput)) {
    const parsedDate = new Date(dataInput);
    if (!isNaN(parsedDate)) {
      return dataInput; // Mantém o formato original se for válido
    }
  }

  const parsedDate = new Date(dataInput);
  if (!isNaN(parsedDate)) {
    return parsedDate.toISOString().slice(0, 19).replace('T', ' ');
  }

  console.warn('Formato de data não reconhecido, usando data atual:', dataInput);
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
};

// Função para montar o corpo do e-mail
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
    - Tempo (h): ${pedido.tempo ? pedido.tempo.toFixed(2) : 0}
    ${pedido.peso || pedido.volume ? `- Peso: ${pedido.peso || 'Não informado'}\n- Volume: ${pedido.volume || 'Não informado'}` : ''}
    - Pausado: ${pedido.pausado ? 'Sim' : 'Não'}
    Itens:
    ${itens.map(item => `- Código: ${item.codigoDesenho}, Qtd Pedida: ${item.quantidadePedido}, Qtd Entregue: ${item.quantidadeEntregue}`).join('\n')}
  `;
  const observacaoText = observacao ? `${observacao}\n\n` : '';
  return `${observacaoText}${detalhesPedido}`.trim();
};

// Configuração do Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'dcashopecia@gmail.com',
    pass: process.env.EMAIL_PASS || 'swxr dcjg xudk tcdz',
  },
});

// Listar todos os pedidos com itens
app.get('/pedidos', (req, res) => {
  db.all('SELECT * FROM pedidos', (err, pedidos) => {
    if (err) {
      console.error('Erro ao listar pedidos:', err.message);
      return res.status(500).json({ message: 'Erro ao listar pedidos', error: err.message });
    }
    db.all('SELECT * FROM itens_pedidos', (err, itens) => {
      if (err) {
        console.error('Erro ao listar itens:', err.message);
        return res.status(500).json({ message: 'Erro ao listar itens', error: err.message });
      }
      const pedidosComItens = pedidos.map(pedido => {
        let tempoFinal = pedido.tempoPausado || 0; // Inicializa com tempoPausado
        if (pedido.status === 'concluido') {
          tempoFinal = pedido.tempo; // Usa o tempo armazenado para pedidos concluídos
        } else if (pedido.status === 'andamento') {
          if (pedido.pausado) {
            tempoFinal = pedido.tempoPausado || 0; // Mantém o tempoPausado ao pausar
          } else if (pedido.dataPausada && !pedido.pausado) {
            // Após retomada, usa tempoPausado e calcula apenas o tempo desde dataPausada
            const tempoAcumulado = pedido.tempoPausado || 0;
            const tempoDesdeRetomada = calcularTempo(pedido.dataPausada, formatDateToLocalISO(new Date(), `fetchPedidos - pedido ${pedido.id}`));
            tempoFinal = Math.round(tempoAcumulado + tempoDesdeRetomada);
          } else {
            // Sem pausa, calcula desde o início
            tempoFinal = Math.round((pedido.tempoPausado || 0) + calcularTempo(pedido.inicio));
          }
        }
        return {
          ...pedido,
          inicio: converterFormatoData(pedido.inicio),
          dataConclusao: pedido.dataConclusao ? converterFormatoData(pedido.dataConclusao) : null,
          dataPausada: pedido.dataPausada ? converterFormatoData(pedido.dataPausada) : null,
          dataInicioPausa: pedido.dataInicioPausa ? converterFormatoData(pedido.dataInicioPausa) : null,
          tempo: tempoFinal,
          itens: itens.filter(item => item.pedido_id === pedido.id)
        };
      });
      res.json(pedidosComItens);
    });
  });
});

// Criar um novo pedido com itens
app.post('/pedidos', async (req, res) => {
  const { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, itens } = req.body;

  console.log('Dados recebidos no POST /pedidos:', req.body);

  // Validação dos campos obrigatórios
  if (!empresa || !numeroOS || !dataEntrada || !previsaoEntrega || !status || !inicio || !Array.isArray(itens) || itens.length === 0) {
    console.error('Campos obrigatórios ausentes ou itens inválidos:', req.body);
    return res.status(400).json({ message: 'Campos obrigatórios ausentes ou itens inválidos' });
  }

  // Validação dos itens
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

  // Converter o formato da data inicio para YYYY-MM-DD HH:MM:SS
  const inicioFormatado = converterFormatoData(inicio);

  const pedidoSql = `
    INSERT INTO pedidos (empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  const pedidoValues = [empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel || null, status, inicioFormatado];

  try {
    console.log('Inserindo pedido principal com valores:', pedidoValues);
    const result = await runQuery(pedidoSql, pedidoValues);
    const pedidoId = result.lastID;
    console.log('Pedido inserido com ID:', pedidoId);

    const itemSql = `
      INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue)
      VALUES (?, ?, ?, ?)
    `;
    const totalItens = itens.length;

    if (totalItens === 0) {
      const novoPedido = { id: pedidoId, empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio: inicioFormatado, itens: [] };
      return res.status(201).json(novoPedido);
    }

    const itemPromises = itens.map(item => {
      const { codigoDesenho, quantidadePedido, quantidadeEntregue } = item;
      console.log('Inserindo item:', { pedido_id: pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue });
      return runQuery(itemSql, [pedidoId, codigoDesenho, quantidadePedido, quantidadeEntregue || 0]);
    });

    await Promise.all(itemPromises);
    console.log(`Todos os ${totalItens} itens inseridos com sucesso`);

    const novoPedido = { id: pedidoId, empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio: inicioFormatado, itens };
    res.status(201).json(novoPedido);
  } catch (err) {
    console.error('Erro ao processar pedido:', err.message, 'Stack:', err.stack);
    res.status(500).json({ message: 'Erro ao processar pedido', error: err.message, stack: err.stack });
  }
});

// Atualizar um pedido com itens
app.put('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio, tempo, peso, volume, dataConclusao, pausado, tempoPausado, dataPausada, dataInicioPausa, itens } = req.body;

  console.log('Dados recebidos no PUT /pedidos:', req.body);

  // Converter o formato da data inicio, dataConclusao, dataPausada e dataInicioPausa
  const inicioFormatado = converterFormatoData(inicio);
  const dataConclusaoFormatada = status === 'concluido' && !dataConclusao
    ? new Date().toISOString().slice(0, 19).replace('T', ' ')
    : dataConclusao ? converterFormatoData(dataConclusao) : null;
  const dataPausadaFormatada = dataPausada ? converterFormatoData(dataPausada) : null;
  const dataInicioPausaFormatada = dataInicioPausa ? converterFormatoData(dataInicioPausa) : null;

  // Ajustar o tempo com base no estado pausado
  let tempoFinal = tempo || 0;
  if (pausado === 1) {
    // Ao pausar, o tempo deve ser igual a tempoPausado
    tempoFinal = tempoPausado || tempo || 0;
  } else if (dataPausada && pausado === 0) {
    // Ao retomar, o tempo deve ser tempoPausado mais o tempo decorrido desde dataPausada
    const tempoAcumulado = tempoPausado || 0;
    const tempoDesdeRetomada = calcularTempo(dataPausada, formatDateToLocalISO(new Date(), `retomarPedido - pedido ${id}`));
    tempoFinal = Math.round(tempoAcumulado + tempoDesdeRetomada);
  }

  const pedidoSql = `
    UPDATE pedidos SET
      empresa = ?, numeroOS = ?, dataEntrada = ?, previsaoEntrega = ?, responsavel = ?,
      status = ?, inicio = ?, tempo = ?, peso = ?, volume = ?, dataConclusao = ?, pausado = ?,
      tempoPausado = ?, dataPausada = ?, dataInicioPausa = ?
    WHERE id = ?
  `;
  const pedidoValues = [
    empresa,
    numeroOS,
    dataEntrada,
    previsaoEntrega,
    responsavel || null,
    status,
    inicioFormatado,
    tempoFinal,
    peso || null,
    volume || null,
    dataConclusaoFormatada,
    pausado || 0,
    tempoPausado || 0,
    dataPausadaFormatada,
    dataInicioPausaFormatada,
    id
  ];

  try {
    console.log('Atualizando pedido com valores:', pedidoValues);
    const result = await runQuery(pedidoSql, pedidoValues);
    if (result.changes === 0) {
      console.error('Pedido não encontrado:', id);
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }

    console.log('Deletando itens antigos para pedido_id:', id);
    await runQuery('DELETE FROM itens_pedidos WHERE pedido_id = ?', [id]);

    const itemSql = `
      INSERT INTO itens_pedidos (pedido_id, codigoDesenho, quantidadePedido, quantidadeEntregue)
      VALUES (?, ?, ?, ?)
    `;
    const totalItens = itens.length;

    if (totalItens === 0) {
      const pedidoAtualizado = { id, empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio: inicioFormatado, tempo: tempoFinal, peso, volume, dataConclusao: dataConclusaoFormatada, pausado, itens: [] };
      return res.json(pedidoAtualizado);
    }

    const itemPromises = itens.map(item => {
      const { codigoDesenho, quantidadePedido, quantidadeEntregue } = item;
      console.log('Inserindo item:', { pedido_id: id, codigoDesenho, quantidadePedido, quantidadeEntregue });
      return runQuery(itemSql, [id, codigoDesenho, quantidadePedido, quantidadeEntregue || 0]);
    });

    await Promise.all(itemPromises);
    console.log(`Todos os ${totalItens} itens atualizados com sucesso`);

    const pedidoAtualizado = { id, empresa, numeroOS, dataEntrada, previsaoEntrega, responsavel, status, inicio: inicioFormatado, tempo: tempoFinal, peso, volume, dataConclusao: dataConclusaoFormatada, pausado, itens };
    res.json(pedidoAtualizado);
  } catch (err) {
    console.error('Erro ao atualizar pedido:', err.message, 'Stack:', err.stack);
    res.status(500).json({ message: 'Erro ao atualizar pedido', error: err.message, stack: err.stack });
  }
});

// Excluir um pedido
app.delete('/pedidos/:id', async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    console.log('Deletando pedido com id:', id);
    const result = await runQuery('DELETE FROM pedidos WHERE id = ?', [id]);
    if (result.changes === 0) {
      console.error('Pedido não encontrado para exclusão:', id);
      return res.status(404).json({ message: 'Pedido não encontrado' });
    }
    console.log('Pedido excluído:', id);
    res.status(204).send();
  } catch (err) {
    console.error('Erro ao excluir pedido:', err.message, 'Stack:', err.stack);
    res.status(500).json({ message: 'Erro ao excluir pedido', error: err.message, stack: err.stack });
  }
});

// Enviar e-mail
app.post('/enviar-email', async (req, res) => {
  const { pedido, observacao } = req.body;

  console.log('Dados recebidos no POST /enviar-email:', { pedido, observacao });

  if (!pedido || !pedido.numeroOS) {
    console.error('Erro: Nenhum pedido ou numeroOS fornecido para envio de e-mail');
    return res.status(400).json({ message: 'Dados do pedido inválidos ou número da OS não fornecido' });
  }

  // Valida e corrige o campo inicio antes de enviar o e-mail
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