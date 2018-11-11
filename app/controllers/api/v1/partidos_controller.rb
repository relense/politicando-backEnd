class Api::V1::PartidosController < ApplicationController
  def index
    partidos = Partido.all

    render json: partidos, status: 200
  end

  def partie_articles
    article_ids = ArticlesPartido.where(partido_id: params["partido_id"])

    articles = []

    article_ids.each do |article|
      articles.push(Article.find article.article_id)
    end

    # articles.sort {|vn1, vn2| vn2[:published_time] <=> vn1[:published_time]}
    articles_sorted = articles.sort_by { |h| h[:published_time] }.reverse!



    render json: articles_sorted, status: 200
  end

end
