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

    articles_sorted = articles.sort_by { |h| h[:published_time] }.reverse!

    render json: articles_sorted.first(10), status: 200
  end

  def get_ten
    article_ids = ArticlesPartido.where(partido_id: params["partido_id"])

    articles = []

    article_ids.each do |article|
      articles.push(Article.find article.article_id)
    end

    articles_sorted = articles.sort_by { |h| h[:published_time] }.reverse!

    last_article_index = articles_sorted.index { |h| h[:id] == params["article_id"].to_i}
    new_articles = articles_sorted[(last_article_index + 1)..(last_article_index + 10)]

    render json: new_articles, status: 200
  end

end
