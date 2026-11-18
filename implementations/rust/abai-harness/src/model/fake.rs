//! A model provider for tests: a local HTTP server that records each
//! request and answers from a list.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

/// One request as the server received it.
#[derive(Debug, Clone, PartialEq)]
pub struct Received {
    pub path: String,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Received {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

/// An answer the server gives: a status, extra header lines, a body.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Answer {
    pub fn ok(body: Value) -> Self {
        Self {
            status: 200,
            headers: Vec::new(),
            body: body.to_string(),
        }
    }

    pub fn status(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.to_string(),
        }
    }
}

/// The server. It answers on a thread of its own until it is dropped.
#[derive(Debug)]
pub struct FakeProvider {
    /// `http://127.0.0.1:<port>`.
    pub url: String,
    pub received: Arc<Mutex<Vec<Received>>>,
    answers: Arc<Mutex<Vec<Answer>>>,
    delay: Arc<Mutex<Duration>>,
}

fn serve(
    mut stream: TcpStream,
    received: &Mutex<Vec<Received>>,
    answers: &Mutex<Vec<Answer>>,
    delay: Duration,
) {
    let mut reader = BufReader::new(stream.try_clone().expect("a socket clones"));
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
    let mut headers = Vec::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_lowercase(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    received.lock().unwrap().push(Received {
        path,
        headers,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    });
    let answer = {
        let mut answers = answers.lock().unwrap();
        if answers.is_empty() {
            Answer::status(
                500,
                Value::String("the test gave no answer for this".into()),
            )
        } else {
            answers.remove(0)
        }
    };
    std::thread::sleep(delay);
    let mut head = format!(
        "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        answer.status,
        answer.body.len()
    );
    for (name, value) in &answer.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(answer.body.as_bytes());
}

impl FakeProvider {
    /// Start a server that gives these answers, in order, one a request.
    pub fn start(answers: Vec<Answer>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
        let url = format!("http://{}", listener.local_addr().expect("an address"));
        let received = Arc::new(Mutex::new(Vec::new()));
        let answers = Arc::new(Mutex::new(answers));
        let delay = Arc::new(Mutex::new(Duration::ZERO));
        let (seen, left, wait) = (received.clone(), answers.clone(), delay.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let delay = *wait.lock().unwrap();
                serve(stream, &seen, &left, delay);
            }
        });
        Self {
            url,
            received,
            answers,
            delay,
        }
    }

    /// Make every answer from now on wait this long before it is sent.
    pub fn set_delay(&self, delay: Duration) {
        *self.delay.lock().unwrap() = delay;
    }

    /// Add answers for the requests still to come.
    pub fn then(&self, more: Vec<Answer>) {
        self.answers.lock().unwrap().extend(more);
    }

    /// The requests received so far.
    pub fn requests(&self) -> Vec<Received> {
        self.received.lock().unwrap().clone()
    }
}
