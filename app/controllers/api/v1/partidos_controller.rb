class Api::V1::PartidosController < ApplicationController
  def index
    partidos = Partido.all

    render json: partidos, status: 200
  end
end
