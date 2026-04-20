import http from "node:http";

export type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => boolean | Promise<boolean>;

export type RouteList = RouteHandler[];

